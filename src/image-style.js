// 画风特征提取（CLIP 图像编码器）。
//
// 为什么用 CLIP 而不是亮度/饱和度那类手工统计量：
//   手工统计量（宽高比、分辨率、清晰度、明暗）反映的是**尺寸与画质**，不是画风。
//   用它们打分等于在筛「竖图+高清+不糊」，跟「这个画师/这种笔触」毫无关系。
//   CLIP 的 512 维图像向量编码的是**视觉语义与风格**（笔触、上色、构图、题材倾向），
//   用它算与「用户收藏」的余弦相似度，才是真正的「像不像他喜欢的画风」。
//
// 模型：Xenova/clip-vit-base-patch32 的量化 ONNX（85MB，CPU 可跑）。
// 输入：224×224 RGB，CLIP 标准归一化。输出：512 维向量（已 L2 归一化，可直接点积算余弦）。
//
// 注意：推理走 Python + onnxruntime（本机已装），因为 node 侧没有 ONNX 运行时依赖，
// 且这是**离线批处理**（入库时算一次），不在请求路径上，多一层进程调用可接受。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MODEL = 'models/clip-vision-quantized.onnx';

/**
 * 批量提取画风向量（512 维）。用 Python 一次算完一批，避免逐张起进程。
 *
 * ⚠️ **必须逐张推理，不能组 batch**：实测该量化模型的输出会受**批内其它样本影响**
 * （同一张图单独跑 / 与别的图组成 2 张批 / 3 张批，余弦只有 0.988~0.992，数值不一致）。
 * 这是量化算子的固有行为，会破坏「同一张图永远得到同一个分」的可复现性。
 * 逐张跑虽然慢些（约 90~150ms/张），但结果严格确定（实测重复提取字节完全相同）。
 *
 * @param {string[]} files 图片本地路径
 * @returns {Promise<Array<number[]|null>>} 与输入等长的向量数组（失败为 null）
 */
export function extractStyleVectors(files, { timeoutMs = 900000 } = {}) {
  if (!files?.length) return Promise.resolve([]);
  if (!fs.existsSync(MODEL)) return Promise.reject(new Error(`缺少模型文件 ${MODEL}（请先下载 CLIP 量化模型）`));

  const py = `
import sys, json, os
import numpy as np
from PIL import Image
import onnxruntime as ort

files = json.loads(sys.argv[1])
so = ort.SessionOptions(); so.log_severity_level = 3
sess = ort.InferenceSession(${JSON.stringify(MODEL)}, so, providers=['CPUExecutionProvider'])
input_name = sess.get_inputs()[0].name

# CLIP 标准预处理：resize 224 + 中心裁剪 + 按 ImageNet 均值方差归一化
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD  = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)

def preprocess(p):
    with Image.open(p) as im:
        im = im.convert('RGB')
        w, h = im.size
        # 短边缩放到 224 再中心裁剪（与 CLIP 官方一致）
        scale = 224 / min(w, h)
        im = im.resize((max(224, int(w*scale)), max(224, int(h*scale))), Image.BICUBIC)
        w2, h2 = im.size
        left, top = (w2-224)//2, (h2-224)//2
        im = im.crop((left, top, left+224, top+224))
        a = np.asarray(im, dtype=np.float32) / 255.0
    a = (a - MEAN) / STD
    return a.transpose(2, 0, 1)  # CHW

# 逐张推理（见函数注释：组 batch 会让输出随批内其它样本变化，破坏可复现性）
out = []
for p in files:
    try:
        arr = preprocess(p)[None, ...].astype(np.float32)   # (1,3,224,224)
        vec = sess.run(None, {input_name: arr})[0][0]        # (512,)
        n = np.linalg.norm(vec)
        out.append([float(x) for x in (vec / max(n, 1e-8))])
    except Exception:
        out.append(None)
print(json.dumps(out))
`;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('python', ['-c', py, JSON.stringify(files)], { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('画风提取超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(t); reject(e); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code !== 0) {
        reject(new Error(`画风提取失败(exit ${code}): ${Buffer.concat(err).toString('utf8').slice(-300)}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
      } catch (e) {
        reject(new Error('画风向量解析失败: ' + e.message));
      }
    });
  });
}

/** 余弦相似度（向量已归一化，点积即可）。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** 多个向量的均值（再归一化），用作「风格中心」。 */
export function meanVector(vectors) {
  const valid = vectors.filter((v) => Array.isArray(v) && v.length);
  if (!valid.length) return null;
  const dim = valid[0].length;
  const acc = new Float64Array(dim);
  for (const v of valid) for (let i = 0; i < dim; i++) acc[i] += v[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) { acc[i] /= valid.length; norm += acc[i] * acc[i]; }
  norm = Math.sqrt(norm) || 1;
  return Array.from(acc, (x) => x / norm);
}

export const CLIP_MODEL_PATH = MODEL;
