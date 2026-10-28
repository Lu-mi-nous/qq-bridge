import { z } from 'zod';
import { upscaleImage, shrinkForPublish, probeUpscale } from './lib/upscale.js';

// 超分可用性：插件开启 + 取图工具未关闭 + 本机确实有 Upscayl（只 stat 文件）。
// 不满足时工具**不注册**——挂一个必然失败的工具只会让模型去试再解释失败。
function upscaleReady(ctx) {
  try {
    const uc = ctx.config.get() ?? {};
    return probeUpscale({ binDir: uc.binDir, modelDir: uc.modelDir, model: uc.model }).ok === true;
  } catch {
    return false;
  }
}

/**
 * 为什么给模型一个"主动超分"工具，而不是只让桥接自动处理：
 * 自动那只在**长边 < 400** 时触发（太小到文字不足 1 个 patch 才会看不清）。
 * 但真实场景里还有一类：图不算小（比如 800×600），可内容是远景/小字/老照片，
 * 模型看得见轮廓却认不出细节。这时它应该能自己决定"放大再看看"，
 * 而不是只能报"看不清"。这也符合"失败要显式、给模型可用手段"的约定。
 */
export function registerUpscaleTools(ctx) {
  ctx.mcp?.registerTool(
    'qq_upscale_image',
    '用超分（Real-ESRGAN）把 QQ 消息里的一张图放大，用于**群友明确要求**或确实看不清细节时。\n\n'
    + '【什么时候一定会用】群友说「帮我超分」「放大一下」「来个高清」「清晰点」「分辨率太低了」「糊了，放大看看」'
    + '「这张图能不能变清楚」「超分辨率」这类话时——这是**点名要的功能**，不要回"我做不到"或"我只有收藏和发送"，直接调本工具。'
    + '即使原图看着还行、你认为没必要，只要群友明确要求放大，也照做（他可能想要一张更清楚的图存下来）。\n\n'
    + '【什么时候自己判断】群友没明说、但你要看清细节才能回答（远景小字、老照片、远处人脸、模糊表情包）。'
    + '这种情况传 publish=false 只看不发；只有群友想要放大图本身时才发到会话。\n\n'
    + '动图请先按普通取图方式查看（桥接已抽帧拼图），本工具只处理静态图。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      index: z.number().optional().describe('消息里有多个媒体时指定第几个（从 1 开始），默认第 1 个'),
      model: z.string().optional().describe('超分模型：upscayl-standard-4x(通用,默认) / upscayl-lite-4x(最快) / digital-art-4x(二次元) / high-fidelity-4x(照片) / remacri-4x(强锐化) / ultrasharp-4x(最锐)。群友说「二次元/动漫图」选 digital-art，说「快点」选 lite'),
      publish: z.boolean().optional().describe('是否把放大结果发到会话给群友看，默认 true。群友主动要求超分时应为 true（他要的就是这张图）；你自己只想看清时传 false'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, index, model, publish, token }) => {
      try {
        // raw=1：拿**原始像素**再超分。若走默认路径，桥接会先把小图 lanczos 放大到 1220px，
        // 超分工具看到的已是插值后的糊图，既无收益也会失真（实测 200×163 → 1220×994）。
        const data = await ctx.mcp.callService('messageImage', { key, messageId, token });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可取到的图片：${data?.note || '未找到'}` }], isError: true };
        }
        const want = Math.max(1, Number(index) || 1);
        const img = images[want - 1];
        if (!img?.data) {
          return { content: [{ type: 'text', text: `第 ${want} 个媒体取不到图像内容（共 ${images.length} 个）。` }], isError: true };
        }
        if (img.animated) {
          return { content: [{ type: 'text', text: '这是动图，桥接已把它抽帧拼成一张图送给模型；超分不处理动图（会丢帧语义）。请直接按取图结果作答。' }] };
        }
        const buf = Buffer.from(img.data, 'base64');
        const uc = ctx.config.get() ?? {};
        const r = await upscaleImage(buf, {
          mimeType: img.mimeType || 'image/png',
          model: model || uc.model,
          binDir: uc.binDir,
          modelDir: uc.modelDir,
          timeoutMs: uc.timeoutMs,
          force: true
        });
        if (!r.upscaled) {
          const why = {
            'no-upscayl-bin': '本机没找到 Upscayl 的 upscayl-bin（配置项 socialV2.upscale.binDir 可指定目录）',
            'no-model': 'Upscayl 的 models 目录里没有可用模型',
            'breaker-open': '超分刚刚连续失败，已暂时停用（避免每次调用都卡住），直接看原图即可',
            'animated-gif': '动图不支持超分',
            'unknown-size': '读不出这张图的尺寸',
            'input-too-large': '原图已经很大，超分没有收益（应直接看原图）',
            'already-large-enough': '原图已经够大'
          }[String(r.reason || '').split(':')[0]] || r.reason || '未知原因';
          return { content: [{ type: 'text', text: `超分未执行：${why}。请按原图作答。` }] };
        }
        const note = `[已超分放大：${r.from} → ${r.to}，模型 ${r.model}，用时 ${(r.ms / 1000).toFixed(1)}s。这是同一张图的放大版，不是另一张图。]`;

        // 把放大结果发回会话（2026-10-19 用户反馈「超分完没有把超分后的结果发回」）。
        // 默认发；publish=false 时只给模型看（它自己拿不准、不需要群友看到放大版）。
        // 发送失败**不影响**把图片交给模型：模型仍能看图作答，只是群友看不到放大版。
        let publishNote = '';
        if (publish !== false) {
          try {
            // **不压缩，原样发**（2026-10-19 用户要求「尽量不要压缩，除非超过阈值」）。
            //
            // 为什么现在可以完全不压：SnowLuma 的 2MB 上限只限制 **HTTP 请求体**
            // （`readRequestBody(req, maxBytes = 2 * 1024 * 1024)`），不限制图片本身。
            // 桥接对 >1.4MB 的 Buffer 起一个只服务这张图的一次性回环服务，请求体只有几十字节。
            // 所以这里只在极少数情况下才压（payload 大到连桥接 8MB 请求体都放不下）。
            const HARD_LIMIT = 6 * 1024 * 1024;
            let payload = r.buffer;
            if (payload.length > HARD_LIMIT) {
              const shrunk = await shrinkForPublish(payload, HARD_LIMIT);
              if (shrunk) payload = shrunk;
            }
            const sent = await ctx.mcp.callService('publish', { key, token, data: payload.toString('base64') });
            publishNote = sent?.ok
              ? `已把放大后的图发到当前会话（群友能看到）。`
              : `放大图**没能发出去**（${sent?.error ?? '未知原因'}），群友看不到；如果群友在等这张图，请如实说明。`;
          } catch (error) {
            publishNote = `放大图**没能发出去**（${error?.message ?? error}），群友看不到。`;
          }
        } else {
          publishNote = `按 publish=false 只放大给你自己看，没有发到会话。`;
        }

        return {
          content: [
            { type: 'text', text: `${note}\n${publishNote}${images.length > 1 ? `\n（消息共 ${images.length} 个媒体，这是第 ${want} 个）` : ''}` },
            { type: 'image', mimeType: r.mimeType, data: r.buffer.toString('base64') }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `超分失败：${error?.message ?? error}` }], isError: true };
      }
    },
    {
      isEnabled: () => {
        return ctx.config.get()?.enabled !== false
          && ctx.config.toolFlag('getImages') !== false
          && upscaleReady(ctx);
      }
    }
  );
}
