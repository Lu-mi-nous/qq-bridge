import { z } from 'zod';
import { probeSovits, DEFAULT_SOVITS_DIR } from '../../src/plugin-api/speech.js';

/**
 * 语音合成是否真的可用（只 stat 文件，不启动任何进程）。
 *
 * 工具**注册时机**在 MCP 启动时决定（注册了就一直在，不能运行时增删），
 * 所以这里只按 tts 插件同一套规则探测必需文件；探测失败 → 工具不注册。
 */
function sovitsReady(ctx) {
  try {
    const t = ctx.config.get() ?? {};
    return probeSovits({
      dir: t.dir || DEFAULT_SOVITS_DIR,
      gptModel: t.gptModel,
      sovitsModel: t.sovitsModel,
      refAudio: t.refAudio,
      refText: t.refText,
      refLang: t.refLang,
      voiceName: t.voiceName,
      device: t.device,
      voiceId: t.voiceId,
      weightsId: t.weightsId,
      refMode: t.refMode
    }).ok === true;
  } catch {
    return false;
  }
}

export function registerTtsTools(ctx) {
  // 只在 TTS 真可用时注册：不可用时工具**不存在**，模型不会看到、
  // 也就不会承诺一个做不到的能力（这比注册了再报错好）。
  ctx.mcp?.registerTool(
    'qq_send_voice',
    '把一句话**用语音发**到当前会话（群友会听到声音，不是文字）。\n\n'
    + '【什么时候用】群友明确要听声音时：「发个语音」「说句听听」「用语音回我」'
    + '「来一段」「唱一个」（唱不了，但可以说）这类。日常聊天**不要**主动用——'
    + '语音比文字吵，群里频繁发会被嫌。\n'
    + '【说什么】你自己组织一句话（≤140 字），口语化、别太长。'
    + '念出来会尴尬的内容（链接、代码、大段数字）不要用语音，改发文字。\n'
    + '【发完怎么说】语音气泡已经发出去，别再复述同一句话——'
    + '要么不配文字，要么只加一两个字的语气（「喏」「咳」）。\n'
    + '【失败时】如实说发不出来（可能正在加载模型），改成文字回答，不要假装发了。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('要念出来的话，口语化，≤140 字')
    },
    async ({ key, token, text }) => {
      try {
        const data = await ctx.mcp.callService('send', { key, token, text });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发语音失败：${error?.message ?? error}。可以改用文字回答，但不要假装语音已发出。` }], isError: true };
      }
    },
    {
      isEnabled: () => {
        return ctx.config.get()?.enabled === true
          && ctx.config.toolFlag('sendVoice') !== false
          && sovitsReady(ctx);
      }
    }
  );
}
