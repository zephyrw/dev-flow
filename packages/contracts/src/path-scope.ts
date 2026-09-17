/** Match one approved file or directory, with a separator boundary. */
export function matchesScopePath(
  file: string,
  allowed: string,
  ignoreCase = false,
) {
  const normalize = (value: string) =>
    value.replaceAll("\\", "/").replace(/\/+$/, "");
  let path = normalize(file),
    root = normalize(allowed);
  if (!root || [path, root].some((value) => value.split("/").includes("..")))
    return false;
  if (ignoreCase) {
    path = path.toLowerCase();
    root = root.toLowerCase();
  }
  return path === root || path.startsWith(root + "/");
}
