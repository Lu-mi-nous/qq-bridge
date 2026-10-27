// 运行时启动与轮询（C6 runtime 拆分）。
// 基础卡 surface 自己挂载；这里只启动背景/摘要/顶部状态等公共运行时。
initSummaryGloss();
initWaveField();
refresh();
refreshSummaries();
setInterval(() => { refresh(); refreshSummaries(); }, 3000);
