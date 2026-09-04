import path from "node:path";

function relativeFile(value) {
  if (!value) return null;
  return path.relative(process.cwd(), String(value)).replaceAll("\\", "/");
}

export default async function* p2bNodeTestReporter(source) {
  for await (const event of source) {
    if (event.type === "test:fail") {
      yield JSON.stringify({
        type: event.type,
        name: event.data?.name ?? "",
        file: relativeFile(event.data?.file),
        nesting: event.data?.nesting ?? null,
        detailsType: event.data?.details?.type ?? null,
        errorCode: event.data?.details?.error?.code ?? null,
      }) + "\n";
    }
    if (event.type === "test:summary") {
      yield JSON.stringify({
        type: event.type,
        counts: event.data?.counts ?? null,
      }) + "\n";
    }
  }
}
