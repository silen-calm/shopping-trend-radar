export function youtubeThumbUrls(item) {
  const variants = ["hqdefault", "sddefault", "mqdefault", "default"];
  return variants.flatMap((name) => [
    `https://i.ytimg.com/vi/${item.id}/${name}.jpg`,
    `https://img.youtube.com/vi/${item.id}/${name}.jpg`
  ]);
}

export function instagramThumbUrls(item) {
  const direct = item.thumb || "";
  const proxied = direct ? `https://images.weserv.nl/?url=${encodeURIComponent(direct.replace(/^https?:\/\//, ""))}` : "";
  return [direct, proxied].filter(Boolean);
}

export function collectThumbJobs(data) {
  const jobs = [];
  for (const item of data.youtube || []) {
    jobs.push({ type: "youtube", id: item.id, urls: youtubeThumbUrls(item) });
  }
  for (const item of data.instagram || []) {
    const urls = instagramThumbUrls(item);
    if (urls.length) jobs.push({ type: "instagram", id: item.code || item.link, urls });
  }
  return jobs;
}
