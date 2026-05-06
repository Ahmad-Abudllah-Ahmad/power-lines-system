/** `original.mp4` + `detections_frames.json` in the same folder as the annotated video URL. */
export function videoResultsAuxUrlsFromAnnotatedVideoUrl(
  videoUrl: string
): { originalUrl: string; framesUrl: string } | null {
  const u = videoUrl.trim();
  const i = u.lastIndexOf("/");
  if (i < 0) return null;
  const dir = u.slice(0, i);
  if (!dir.includes("/results/")) return null;
  return { originalUrl: `${dir}/original.mp4`, framesUrl: `${dir}/detections_frames.json` };
}
