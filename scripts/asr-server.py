#!/usr/bin/env python
# 常驻 ASR 服务：加载一次 faster-whisper 模型，之后逐行接收音频路径、输出 JSON。
#
# 由 src/asr.js 通过 stdin/stdout 驱动（每行一个音频路径 → 每行一个 JSON 结果）。
#
# 为什么做成常驻（而不是每次新起进程）：
#   实测 large-v3（int8/CPU）加载要 ~7 秒，而识别 12 秒音频只要 ~10.7 秒、
#   22 秒音频 ~12.3 秒——**耗时几乎与音频时长无关**，固定开销占大头。
#   每次重开进程等于白付 7 秒。
#
# 与 Node 侧的约定：
#   - 启动成功后必须往 stderr 打一行 `READY {"loadSec": 7.2, "model": "..."}`
#     （Node 侧靠这行判断"模型真的加载完了"，而不是猜时间）
#   - stdout **只**输出结果 JSON（每行一个），便于按行解析
#   - 收到 `__quit__` 就退出
#
# 容错：单条识别失败只回 {"error": "..."}，不退出进程——
# 一个坏音频不该让整个引擎垮掉（Node 侧会因为退出而进入退避重试）。
import sys
import os
import json
import time


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: asr-server.py <model-path-or-name> [cpu_threads]\n")
        sys.exit(2)
    model_spec = sys.argv[1]
    cpu_threads = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 8

    t0 = time.time()
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"FATAL import faster_whisper: {e}\n")
        sys.exit(3)

    try:
        # compute_type=int8：CPU 上速度/内存最平衡；实测中文识别质量与 float32 无差别
        model = WhisperModel(model_spec, device="cpu", compute_type="int8",
                             cpu_threads=cpu_threads)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"FATAL load model: {e}\n")
        sys.exit(4)

    load_sec = round(time.time() - t0, 1)
    sys.stderr.write("READY " + json.dumps({"loadSec": load_sec, "model": os.path.basename(model_spec.rstrip("/\\")) or model_spec}) + "\n")
    sys.stderr.flush()

    for line in sys.stdin:
        stem = line.strip()
        if not stem:
            continue
        if stem == "__quit__":
            break
        if not os.path.exists(stem):
            print(json.dumps({"error": "audio file not found"}, ensure_ascii=False), flush=True)
            continue
        t1 = time.time()
        try:
            # beam_size=1：贪心解码，速度优先。实测质量足够（中英文都能正确转写）。
            # vad_filter：先做语音活动检测，跳过静音段——视频前几秒常是纯音乐/静音，
            # 不裁剪会让模型把静音"听成"幻觉文本。
            segments, info = model.transcribe(
                stem, beam_size=1, vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500}
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            print(json.dumps({
                "text": text,
                "lang": getattr(info, "language", "") or "",
                "asrSec": round(time.time() - t1, 1)
            }, ensure_ascii=False), flush=True)
        except Exception as e:  # noqa: BLE001
            # 单个文件出错不退出：Node 侧收到 error 会降级，但引擎继续可用
            print(json.dumps({"error": str(e)[:300]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
