/// <reference types="vite/client" />

declare module "*.svg" {
  const src: string;
  export default src;
}

declare const __APP_VERSION__: string;