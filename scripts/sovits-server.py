#!/usr/bin/env python
# GPT-SoVITS 常驻语音合成服务：加载一次模型，之后逐行接收 JSON 请求、输出 JSON 结果。
#
# 由 src/tts.js 通过 stdin/stdout 驱动。为什么常驻：
#   实测本机（RTX 4070 Laptop 8G，fp16）：模型加载 + 首次预热 3.4~5.3 秒，
#   而**推理本身很快**——4 字 1.5 秒、18 字 1.5 秒、42 字 2.9 秒（音频越长越慢）。
#   每次新起进程等于每次都白付加载时间，而"发一条语音"本该是随手就发的。
#
# 协议：
#   启动成功 → stderr 打一行 `READY {"model": "...", "loadSec": 3.4}`
#   stdout **只**输出结果 JSON（每行一个），便于按行解析
#   收到 `__quit__` 退出
#
# 容错：单条合成失败只回 {"error": "..."}，进程继续可用——
# 一条坏文本不该让整个服务垮掉。
#
# ── 目录约定 ─────────────────────────────────────────────────────────
# GPT-SoVITS 是**外部项目**（不在本仓库内），本脚本只负责搭桥：
#   - 通过环境变量 QQB_SOVITS_DIR 找到它的根目录
#   - 通过 QQB_SOVITS_CONFIG 指定 tts_infer.yaml（内含模型与底模路径）
# 这样插件可以被搬到别处、或完全没装（桥接自动降级为纯文字），不需要改代码。
import sys
import os
import io
import json
import time


def emit(obj):
    # 同样走二进制流 + 显式 UTF-8：只在 Windows 上 stdout 可能被当成 GBK，
    # 输出的中文（错误信息、路径）会乱码，Node 侧解析到的就是坏字符串。
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except AttributeError:
        sys.stdout.write(data.decode("utf-8"))
        sys.stdout.flush()


# ── 强制 UTF-8（Windows 上是必须的，否则中文全被打碎）────────────────────
#
# 实测（2026-10-22，用户反馈「试听按钮点完没有能听的音频」）：
#   Node 写入 stdin 的是 UTF-8 字节，但 Windows 下 Python 子进程的 stdio
#   默认按**系统 ANSI 代码页**（简中 = GBK/cp936）解码，于是
#   「你好呀，我是达妮娅」变成 `'���ѽ�����Ǵ���櫡�'`，
#   合成出来的自然是一段听不出内容的噪声（实测只有 1.1 秒的"ふーん"）。
#   症状极具迷惑性：接口返回 200、文件有内容、时长却明显偏短。
#
# 通过 Popen 传 PYTHONIOENCODING 也可以，但那一层在不同启动方式下容易丢；
# 在脚本里自己 reconfigure 最稳，且不影响调用方。
def _force_utf8():
    # 只重配 stdout/stderr；**不要碰 stdin**。
    # 给 stdin 调 reconfigure 会让 sys.stdin.buffer 变成重新包装后的流，
    # 编码可能再次落回 GBK（实测 len 从 18 变成 28 = UTF-8 字节按 GBK 解）。
    # stdin 一律走 sys.stdin.buffer 原始字节 + 显式 utf-8 解码。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001  老版本 Python 没有 reconfigure
            pass


def main():
    _force_utf8()
    root = os.environ.get("QQB_SOVITS_DIR", "").strip()
    if not root or not os.path.isdir(root):
        sys.stderr.write(f"FATAL QQB_SOVITS_DIR 无效: {root!r}\n")
        sys.exit(2)
    cfg_path = os.environ.get("QQB_SOVITS_CONFIG", "").strip() or os.path.join(
        root, "GPT_SoVITS", "configs", "tts_infer.yaml"
    )
    device = os.environ.get("QQB_SOVITS_DEVICE", "cuda").strip() or "cuda"
    is_half = os.environ.get("QQB_SOVITS_HALF", "1").strip() != "0"

    # GPT-SoVITS 的模块是按它的仓库根目录组织的（`from GPT_SoVITS.xxx` 与 `from text.xxx`
    # 混用），必须把两个目录都放进 sys.path，否则 import 会缺一半。
    os.chdir(root)
    sys.path.insert(0, root)
    sys.path.insert(0, os.path.join(root, "GPT_SoVITS"))

    t0 = time.time()
    try:
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"FATAL import GPT-SoVITS: {e}\n")
        sys.exit(3)

    try:
        cfg = TTS_Config(cfg_path)
        # 设备/half 以环境变量为准：配置文件属于他人项目，别改它，
        # 否则用户更新 GPT-SoVITS 时会把我们的改动覆盖掉。
        cfg.device = device
        cfg.is_half = bool(is_half)

        # ── 控制台配置的权重（2026-10-22 修复）─────────────────────────
        # TTS_Config 只读 tts_infer.yaml 的 custom 段。控制台里改的权重以前
        # 只用于存在性探测，实际加载的仍是 yaml 里的旧权重（实测：UI 显示
        # 爱弥斯、跑的是 dania）。这里用 Node 传来的绝对路径覆盖。
        # 版本必须跟 SoVITS 权重走：v2Pro 与 v2ProPlus 结构不同，用错版本
        # 会加载失败（或加载出错误音色）。GPT-SoVITS 自带按权重头识别的函数。
        t2s_env = os.environ.get("QQB_SOVITS_T2S", "").strip()
        vits_env = os.environ.get("QQB_SOVITS_VITS", "").strip()
        version_env = os.environ.get("QQB_SOVITS_VERSION", "").strip()
        if t2s_env:
            if os.path.exists(t2s_env):
                cfg.t2s_weights_path = t2s_env
            else:
                sys.stderr.write(f"WARN t2s weights not found, keep yaml: {t2s_env}\n")
        if vits_env:
            if os.path.exists(vits_env):
                cfg.vits_weights_path = vits_env
                try:
                    from GPT_SoVITS.process_ckpt import get_sovits_version_from_path_fast
                    info = get_sovits_version_from_path_fast(vits_env)
                    ver = str(info[1]) if isinstance(info, (tuple, list)) and len(info) >= 2 else str(info)
                    if ver in cfg.default_configs:
                        cfg.update_version(ver)
                        sys.stderr.write(f"INFO detected model version: {ver}\n")
                    else:
                        sys.stderr.write(f"WARN unknown model version {ver!r}, keep {cfg.version}\n")
                except Exception as e:  # noqa: BLE001
                    sys.stderr.write(f"WARN detect model version failed: {e}\n")
            else:
                sys.stderr.write(f"WARN vits weights not found, keep yaml: {vits_env}\n")
        if version_env and version_env in cfg.default_configs:
            cfg.update_version(version_env)

        # TTS 初始化时会把 custom 段 save 回 yaml（GPT-SoVITS 自身行为）。
        # 桥接的原则是不修改外部项目，所以这里禁掉写盘；控制台配置每次
        # 启动都会通过环境变量重新覆盖，不需要落进别人的配置文件。
        cfg.save_configs = lambda *args, **kwargs: None

        tts = TTS(cfg)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"FATAL init TTS: {e}\n")
        sys.exit(4)

    # 预热：用一句极短文本真跑一次推理，把 CUDA kernel 编译、jieba 词典、
    # 参考音频的语义提取等一次性开销提前付掉。
    # 不做预热的代价（实测）：**第一条**语音固定比后面每条慢 3~4 秒，
    # 用户点"发语音"后等太久，看起来像卡住。
    warm_ref = os.environ.get("QQB_SOVITS_REF_AUDIO", "").strip()
    warm_text = os.environ.get("QQB_SOVITS_PROMPT_TEXT", "").strip()
    warm_ok = False
    if warm_ref and os.path.exists(warm_ref):
        try:
            for _ in tts.run({
                "text": "嗯",
                "text_lang": "zh",
                "ref_audio_path": warm_ref,
                "prompt_text": warm_text,
                "prompt_lang": "zh",
                "streaming_mode": False,
            }):
                pass
            warm_ok = True
        except Exception as e:  # noqa: BLE001
            # 预热失败不等于不能用（参考音频可能配错，正式请求会明确报错）
            sys.stderr.write(f"WARN warmup failed: {e}\n")

    load_sec = round(time.time() - t0, 1)
    sys.stderr.write("READY " + json.dumps({
        "model": os.path.basename(cfg_path), "loadSec": load_sec,
        "device": device, "warmed": warm_ok,
        # 回报**实际加载**的权重与版本，控制台据此核对配置是否生效
        "t2s": os.path.basename(str(getattr(cfg, "t2s_weights_path", "") or "")),
        "vits": os.path.basename(str(getattr(cfg, "vits_weights_path", "") or "")),
        "version": str(getattr(cfg, "version", "") or ""),
    }, ensure_ascii=False) + "\n")
    sys.stderr.flush()

    # 从 **二进制流** 逐行读，自己按 UTF-8 解码。
    #
    # ── 为什么 stdin 这条路最终放弃了（2026-10-22 实测）────────────────
    #
    # Windows 下 Python 子进程的管道 stdio 会被包成文本流，编码取系统 ANSI
    # 代码页（简中 = cp936/GBK）。Node 写进去的 UTF-8 中文因此被打碎：
    #   「你好呀，我是达妮娅。今天也要开心哦。」(18 字)
    #   读出来 len=28、repr='���ѽ�����Ǵ���櫡�'（UTF-8 的 54 字节按 GBK 解）
    # 结果是合成出一段听不出内容的短噪声（0.5~0.9 秒）。
    #
    # 试过但**都不可靠**：`sys.stdin.reconfigure('utf-8')`、
    # `PYTHONIOENCODING=utf-8`、`sys.stdin.buffer.readline()`（在某些包装下仍走 GBK）。
    # 而同一份 JSON 走**文件**读取永远正确（实测 LEN=18）。
    #
    # 所以协议改成：Node 把请求写成 UTF-8 文件，这里只传文件路径。
    # stdin 只负责传"一行的绝对路径"，纯 ASCII，不存在编码问题。
    # 代价是多一次落盘（几十字节），换来的是确定性——值。
    for raw in iter(sys.stdin.buffer.readline, b""):
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        if line == "__quit__":
            break
        if line == "__ping__":
            emit({"ok": True, "pong": True})
            continue
        # 约定：stdin 上只有两种东西——`__quit__`/`__ping__`，以及一个 JSON 文件路径。
        req_path = line
        try:
            with open(req_path, "r", encoding="utf-8") as f:
                req = json.load(f)
        except Exception as e:  # noqa: BLE001
            emit({"error": "bad request file: " + str(e)[:120]})
            continue
        try:
            os.unlink(req_path)
        except Exception:  # noqa: BLE001
            pass

        text = str(req.get("text") or "").strip()
        ref = str(req.get("ref_audio_path") or "").strip()
        prompt = str(req.get("prompt_text") or "").strip()
        if not text:
            emit({"error": "empty text"})
            continue
        if not ref or not os.path.exists(ref):
            emit({"error": f"ref audio not found: {ref}"})
            continue
        out = str(req.get("out") or "").strip()
        if not out:
            emit({"error": "missing out path"})
            continue

        t1 = time.time()
        # 编码诊断（默认关闭，QQB_TTS_DEBUG=1 时开启）：
        # 只记长度与前 6 个字的**码点**——码点不受任何终端/日志编码影响，
        # 是判断"字符串本身对不对"的唯一可靠信号（坏字符会变成 fffd）。
        # 排查"语音变短/听不清"时先看这里：len 应该是中文字数，不是字节数。
        try:
            if os.environ.get("QQB_TTS_DEBUG") == "1":
                cps = " ".join("%04x" % ord(c) for c in text[:6])
                sys.stderr.buffer.write(
                    ("SYNTH_IN len=" + str(len(text)) + " cp=" + cps + "\n").encode("utf-8")
                )
                sys.stderr.buffer.flush()
        except Exception:  # noqa: BLE001
            pass
        try:
            sr = 32000
            chunks = []
            for item in tts.run({
                "text": text,
                "text_lang": str(req.get("text_lang") or "zh"),
                "ref_audio_path": ref,
                "prompt_text": prompt,
                "prompt_lang": str(req.get("prompt_lang") or "zh"),
                "streaming_mode": False,
                "speed_factor": float(req.get("speed") or 1.0),
                # 韵律参数（2026-10-22 方案 B）：全部按请求现传，改完即时生效
                "fragment_interval": float(req.get("fragment_interval") or 0.3),
                "temperature": float(req.get("temperature") or 0.9),
                "top_k": int(req.get("top_k") or 15),
                "top_p": float(req.get("top_p") or 0.95),
                "text_split_method": str(req.get("text_split_method") or "cut5"),
            }):
                # run() 返回 (sample_rate, np.ndarray) 的生成器（流式时多次）
                sr, audio = item[0], item[1]
                chunks.append(audio)
            if not chunks:
                emit({"error": "no audio produced"})
                continue
            import numpy as np
            audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
            if getattr(audio, "dtype", None) is not None and audio.dtype.kind in ("i", "u"):
                audio = audio.astype(np.float32) / 32768.0
            else:
                audio = np.asarray(audio, dtype=np.float32)

            # ── 响度归一（2026-10-22 用户「声音有点过小」）────────────────
            # 实测 GPT-SoVITS 输出 RMS ≈ -38 dBFS、峰值 ≈ -21 dBFS，约为正常
            # 语音的 1/16，手机/群语音里几乎听不清。这里做两件事：
            #   1) 自动增益到目标 RMS -20 dBFS（只提升，不衰减）；
            #   2) 峰值限制在 -1.5 dBFS，避免提升后爆音。
            # volume_gain_db 是手动额外增减（控制台可调）。
            rms = float(np.sqrt(np.mean(np.square(audio.astype(np.float64))))) if audio.size else 0.0
            target_rms = 10 ** (-20.0 / 20.0)
            auto_gain = (target_rms / rms) if rms > 1e-8 else 1.0
            gain = max(1.0, auto_gain)
            try:
                extra_db = float(req.get("volume_gain_db") or 0)
            except Exception:  # noqa: BLE001
                extra_db = 0.0
            gain *= 10 ** (extra_db / 20.0)
            if gain != 1.0:
                audio = audio * gain
            peak_limit = 10 ** (-1.5 / 20.0)
            peak = float(np.max(np.abs(audio))) if audio.size else 0.0
            if peak > peak_limit:
                audio = audio * (peak_limit / peak)

            try:
                if os.environ.get("QQB_TTS_DEBUG") == "1":
                    peak_out = float(np.max(np.abs(audio))) if audio.size else 0.0
                    sys.stderr.buffer.write(
                        ("SYNTH_NORM rms_in=%.1fdB gain=%.1fdB peak_out=%.1fdB\n" % (
                            20 * np.log10(max(rms, 1e-9)),
                            20 * np.log10(max(gain, 1e-9)),
                            20 * np.log10(max(peak_out, 1e-9)),
                        )).encode("utf-8")
                    )
                    sys.stderr.buffer.flush()
            except Exception:  # noqa: BLE001
                pass

            import soundfile as sf
            sf.write(out, audio, sr)
            dur = round(float(len(audio)) / float(sr), 2)
            emit({
                "ok": True,
                "out": out,
                "sr": int(sr),
                "durSec": dur,
                "synthSec": round(time.time() - t1, 2),
                "chars": len(text),
            })
        except Exception as e:  # noqa: BLE001
            emit({"error": str(e)[:300]})


if __name__ == "__main__":
    main()
