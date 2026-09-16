import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';

// Development only: the dev server forwards the API to a local backend, so the browser sees one
// origin and the session cookies work. The browser's Origin header is passed through unchanged
// (changeOrigin: false) because the backend's CORS allowlist names the dev origin.
const API_PATHS = ['/auth', '/conversations', '/query', '/models', '/keys', '/batch', '/workspaces', '/hpa-proxy', '/hpm', '/healthz'];

export default defineConfig(({ mode }) => {
    const isLib = mode === "lib";
    const env = loadEnv(mode, process.cwd(), '');
    const target = env.VITE_APP_LOCAL_BACKEND || 'http://localhost:8015';

    return {
        define: {
            "process.env.NODE_ENV": JSON.stringify(mode),
        },
        build: isLib
          ? {
              lib: {
                  entry: resolve(__dirname, "src/hpa-integrated.jsx"),
                  name: "atlasAI",
                  fileName: (format) => `atlasAI.${format}.js`,
                  formats: ["esm"],
              },
              rollupOptions: {
                  external: [],
                  output: {
                      globals: {
                          react: "React", // Ensure React is properly referenced in UMD
                          "react-dom": "ReactDOM",
                      },
                  },
                  preserveEntrySignatures: 'strict',
              },
              sourcemap: true,
          } : {
              outDir: 'build',
              rollupOptions: {
                  input: {
                      main: './index.html',
                      v2: './index-hpa.html',
                  }
              }
          }
        ,
        plugins: [react()],
        server: {
            port: 3000,
            proxy: Object.fromEntries(
                API_PATHS.map((path) => [path, { target, changeOrigin: false, ws: false }])
            ),
        },
        test: {
            globals: true,
            environment: 'jsdom',
        }
    };
});
