// 注册 ts-resolve-hook（见该文件头注释）；配合 node --experimental-transform-types 使用
import { register } from 'node:module';
register('./ts-resolve-hook.mjs', import.meta.url);
