import type { TvContent } from "@robot/shared";

export interface TvContentViewProps {
  content: TvContent;
}

/**
 * Extracts the YouTube video id from a URL. Returns null if unrecognized.
 */
function parseYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return u.pathname.replace(/^\//, "") || null;
    }
    if (u.hostname.endsWith("youtube.com")) {
      if (u.pathname.startsWith("/embed/")) {
        return u.pathname.split("/embed/")[1]?.split(/[/?]/)[0] ?? null;
      }
      const v = u.searchParams.get("v");
      if (v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

export default function TvContentView({ content }: TvContentViewProps) {
  switch (content.kind) {
    case "youtube": {
      const id = parseYouTubeId(content.url);
      const src = id
        ? `https://www.youtube.com/embed/${id}?autoplay=1&mute=0&rel=0&modestbranding=1&playsinline=1`
        : content.url;
      return (
        <div className="w-full h-full bg-black">
          <iframe
            src={src}
            title={content.title ?? "YouTube"}
            className="w-full h-full"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            frameBorder={0}
          />
        </div>
      );
    }
    case "image":
      return (
        <div className="relative w-full h-full bg-black flex items-center justify-center">
          <img
            src={content.url}
            alt={content.caption ?? ""}
            className="max-w-full max-h-full object-contain"
          />
          {content.caption && (
            <div className="absolute bottom-8 left-0 right-0 text-center text-white text-xl drop-shadow-lg">
              {content.caption}
            </div>
          )}
        </div>
      );
    case "webpage":
      return (
        <iframe
          src={content.url}
          title="webpage"
          className="w-full h-full bg-white"
          frameBorder={0}
        />
      );
    case "text":
      return (
        <div className="w-full h-full bg-black flex items-center justify-center p-12">
          <div className="text-white text-5xl md:text-7xl font-semibold text-center leading-tight max-w-[85vw]">
            {content.text}
          </div>
        </div>
      );
  }
}
