// wrangler.toml bundles *.png as "Data" modules: the default export is the file's bytes.
declare module "*.png" {
  const bytes: ArrayBuffer;
  export default bytes;
}
