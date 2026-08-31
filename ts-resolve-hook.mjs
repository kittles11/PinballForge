/**
 * node ESM resolve hook：相对导入无扩展名时补 .ts 再解析。
 * Cocos TS 源码 import 习惯不带扩展名（如 OrbBalance → './DataModels'），
 * 行为自检要动态 import 这些模块真跑，node 需要 hook 才能解析。
 * 运行方式：node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-xxx.ts
 */
export async function resolve(specifier, context, next) {
    try {
        return await next(specifier, context);
    } catch (err) {
        if (err?.code === 'ERR_MODULE_NOT_FOUND'
            && specifier.startsWith('.')
            && !/\.[cm]?tsx?(?:\?|$)/.test(specifier)) {
            return next(specifier + '.ts', context);
        }
        throw err;
    }
}
