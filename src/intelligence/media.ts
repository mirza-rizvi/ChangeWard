import type { Signal } from "../core/types";

const EXECUTABLE = new Set(["exe", "dll", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "mjs", "jar", "sh", "php", "phtml", "asp", "aspx", "jsp", "cgi", "pl", "py", "apk", "app", "dmg", "hta", "wsf"]);
const HTML = new Set(["html", "htm", "xhtml", "shtml", "mht", "mhtml", "xml"]);

/** Metadata-only observations about an uploaded file. No bytes are read. */
export function mediaSignals(filename: string, mimeType: string): Signal[] {
	const signals: Signal[] = [];
	const name = filename.toLowerCase().trim();
	const mime = mimeType.toLowerCase().trim();
	const parts = name.split(".").filter(Boolean);
	const ext = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
	if (ext === "svg" || ext === "svgz" || mime === "image/svg+xml") signals.push({ code: "media.svg", detail: "SVG can contain script" });
	if (HTML.has(ext) || mime === "text/html" || mime === "application/xhtml+xml") signals.push({ code: "media.html", detail: ext || mime });
	if (EXECUTABLE.has(ext)) signals.push({ code: "media.executable", detail: `.${ext}` });
	if (parts.length > 2) {
		const inner = parts[parts.length - 2] ?? "";
		if (EXECUTABLE.has(inner) || HTML.has(inner)) signals.push({ code: "media.double-extension", detail: `.${inner}.${ext}` });
	}
	return signals;
}
