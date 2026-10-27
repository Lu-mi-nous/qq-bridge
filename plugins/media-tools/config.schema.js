// 媒体工具配置说明。
//
// 三个工具共用 `socialV2` 子树：GitHub 截图读 `githubShot.*`；
// 功能菜单与 Token 报表由 `tools.*` 开关控制（菜单内容来自当前配置）。
export const configSchema = {
  'githubShot.enabled': 'boolean',
  'githubShot.sliceHeight': 'integer(400..8000)',
  'githubShot.maxHeight': 'integer(1000..30000)',
  'githubShot.waitMs': 'integer(0..30000)',
  'githubShot.timeoutMs': 'integer(5000..300000)',
  'githubShot.proxy': 'string',
  'tools.sendFeatureMenu': 'boolean',
  'tools.tokenReport': 'boolean'
};

export default configSchema;
