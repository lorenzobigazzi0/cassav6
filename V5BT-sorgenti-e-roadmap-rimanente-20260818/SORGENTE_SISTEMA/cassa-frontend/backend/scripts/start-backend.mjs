if (!String(process.env.PRINTING_ENABLED ?? "").trim()) {
  process.env.PRINTING_ENABLED = "1";
}

await import("../server.js");
