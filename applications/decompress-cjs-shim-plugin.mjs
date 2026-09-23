
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const decompressCjsShimPlugin = {
    name: 'decompress-cjs-shim',
    setup(build) {
        build.onResolve({ filter: /^decompress$/ }, () => ({
            path: 'decompress',
            namespace: 'decompress-cjs-shim'
        }));
        build.onLoad({ filter: /.*/, namespace: 'decompress-cjs-shim' }, async () => {
            // Resolvemos el alias npm a su ruta de disco real (node_modules/decompress/index.js).
            const entry = require.resolve('decompress');
            return {
                contents: `module.exports = require(${JSON.stringify(entry)}).default ?? require(${JSON.stringify(entry)});`,
                loader: 'js',
                resolveDir: require('path').dirname(entry)
            };
        });
    }
};
