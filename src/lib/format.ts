/**
 * How a list writes a number and a moment: a size a person reads at a glance,
 * how long ago something arrived, and a word for what kind of file it is.
 *
 * Shared rather than duplicated, so the file browser and the settings panel
 * cannot end up describing the same size or the same age differently.
 */

/** A size the way a file list reads it: "512 B", "8.4 KB", "141 KB". */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

/** How long ago, in the shortest unit that still says it: "just now", "5m ago". */
export function shortAge(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * How far ahead a moment sits, in the shortest unit that still says it:
 * "any moment", "in 5m", "in 6h". The future counterpart of `shortAge` -
 * reusing an ago-formatter for a future stamp clamps every distance,
 * near or far, to "just now".
 */
export function shortAhead(at: number): string {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (mins < 1) return "any moment";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** A word for the kind of file it is, which reads better than a MIME type. */
const KIND_BY_MIME: Record<string, string> = {
  "application/pdf": "PDF",
  "application/json": "JSON",
  "application/x-ndjson": "JSON",
  "application/xml": "XML",
  "application/yaml": "YAML",
  "application/toml": "TOML",
  "application/zip": "Archive",
  "application/gzip": "Archive",
  "application/x-tar": "Archive",
  "application/x-7z-compressed": "Archive",
  "application/octet-stream": "File",
};

/** The kind of file a MIME type is, in the one word a row has room for. */
export function kindOf(mime: string): string {
  if (KIND_BY_MIME[mime]) return KIND_BY_MIME[mime];
  const [top, sub = ""] = mime.split("/");
  if (top === "image") return "Image";
  if (top === "audio") return "Audio";
  if (top === "video") return "Video";
  if (top === "text") return "Text";
  return sub ? sub[0].toUpperCase() + sub.slice(1) : "File";
}

/**
 * How a routine's schedule reads in the draft preview: "every 30 min" for an
 * interval, "weekdays at 09:00" for a cron that names one time of day.
 *
 * A cron whose minute or hour is not a plain number - a step, a range, a
 * list - has no single time to name, so the interval the draft also carries
 * is the honest description; without one the raw expression (shown beside
 * this) is all there is to say.
 */
export function describeSchedule(d: {
  cron: string;
  interval_min: number;
}): string {
  const every = (mins: number) =>
    mins % 60 === 0
      ? `every ${mins / 60} hour${mins / 60 === 1 ? "" : "s"}`
      : `every ${mins} min`;
  if (!d.cron) return every(d.interval_min);
  const [min, hour, , , dow] = d.cron.split(/\s+/);
  if (!/^\d+$/.test(min ?? "") || !/^\d+$/.test(hour ?? "")) {
    return d.interval_min > 0 ? every(d.interval_min) : "on a custom schedule";
  }
  const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const days =
    dow === "*"
      ? "every day"
      : dow === "1-5"
        ? "weekdays"
        : /^\d$/.test(dow)
          ? [
              "Sundays",
              "Mondays",
              "Tuesdays",
              "Wednesdays",
              "Thursdays",
              "Fridays",
              "Saturdays",
            ][Number(dow)]
          : `days ${dow}`;
  return `${days} at ${at}`;
}
