// ffprobe-static ships no types of its own.
declare module "ffprobe-static" {
  const ffprobeStatic: { path: string };
  export default ffprobeStatic;
}
