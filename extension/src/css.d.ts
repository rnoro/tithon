// esbuild bundles `*.css` imports as text (loader: { ".css": "text" }) so the
// renderer can inject ipywidgets styles into the webview. Declare the shape for
// tsc (which also compiles these files, though only the esbuild bundle is used).
declare module "*.css" {
  const css: string;
  export default css;
}
