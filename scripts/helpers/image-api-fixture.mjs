// 服务层单元测试显式注入实现；生产只通过 Host 获取。
import * as store from '../../plugins/images/lib/image-store.js';
import * as style from '../../plugins/images/lib/image-style.js';
import * as feedback from '../../plugins/images/lib/image-feedback.js';
import * as hint from '../../plugins/images/lib/image-source-hint.js';
import * as archive from '../../plugins/images/lib/image-archive.js';
import * as sources from '../../plugins/images/lib/image-sources.js';
export const imageApi = { ...store, ...style, ...feedback, ...hint, ...archive, ...sources, available: () => true };
