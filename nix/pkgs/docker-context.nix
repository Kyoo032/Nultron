# The files a Docker build context holds, computed from the same ignore file Docker reads, so the Nix build
# copies exactly what `COPY . .` copies and the ignore files stay the one place that decides it.
#
#   docker-context.sourceOf "webapp-deploy/Dockerfile.dockerignore"
#
# The rules are BuildKit's (moby/patternmatcher): blank lines and `#` comments are skipped, a leading `/` is
# dropped, `!` re-includes, and the last pattern that matches a path or any of its parent directories wins.
# `**` spans any number of directories (none included), `*` and `?` stay inside one, and a `[...]` class is
# passed through. Only committed files exist here, because the flake builds what git tracks.
{ lib, repoRoot }:
let
  # Characters that mean something in a POSIX extended regex but nothing in a Docker pattern.
  special = [
    "."
    "+"
    "("
    ")"
    "|"
    "^"
    "$"
    "{"
    "}"
  ];

  toRegex =
    chars:
    if chars == [ ] then
      ""
    else
      let
        c = lib.head chars;
        rest = lib.tail chars;
        next = if rest == [ ] then null else lib.head rest;
        afterNext = if rest == [ ] then [ ] else lib.tail rest;
      in
      if c == "*" && next == "*" then
        if afterNext != [ ] && lib.head afterNext == "/" then
          "(.*/)?" + toRegex (lib.tail afterNext)
        else
          ".*" + toRegex afterNext
      else if c == "*" then
        "[^/]*" + toRegex rest
      else if c == "?" then
        "[^/]" + toRegex rest
      else if c == "\\" && next != null then
        "[" + next + "]" + toRegex afterNext
      else if lib.elem c special then
        "\\" + c + toRegex rest
      else
        c + toRegex rest;

  parseLine =
    line:
    let
      trimmed = lib.trim line;
      negated = lib.hasPrefix "!" trimmed;
      body = lib.removePrefix "/" (lib.trim (lib.removePrefix "!" trimmed));
    in
    if trimmed == "" || lib.hasPrefix "#" trimmed then
      null
    else
      {
        inherit negated;
        regex = toRegex (lib.stringToCharacters (lib.removeSuffix "/" body));
      };

  rulesOf =
    ignoreFile:
    lib.filter (rule: rule != null) (
      map parseLine (lib.splitString "\n" (builtins.readFile (repoRoot + "/${ignoreFile}")))
    );

  # `a/b/c` -> [ "a" "a/b" "a/b/c" ]: a pattern that matches a parent directory matches everything under it.
  prefixes =
    path:
    let
      parts = lib.splitString "/" path;
    in
    lib.genList (i: lib.concatStringsSep "/" (lib.take (i + 1) parts)) (lib.length parts);

  included =
    rules: path:
    let
      candidates = prefixes path;
      hits = rule: lib.any (candidate: builtins.match rule.regex candidate != null) candidates;
    in
    lib.foldl' (keep: rule: if hits rule then rule.negated else keep) true rules;

  relative = file: lib.removePrefix "./" (lib.path.removePrefix repoRoot file);

  filesOf =
    ignoreFile:
    let
      rules = rulesOf ignoreFile;
    in
    lib.filter (included rules) (map relative (lib.filesystem.listFilesRecursive repoRoot));
in
{
  # The relative paths a context keeps.
  filesOf = filesOf;

  # The context as a source tree in the store.
  sourceOf =
    ignoreFile:
    lib.fileset.toSource {
      root = repoRoot;
      fileset = lib.fileset.unions (map (path: repoRoot + "/${path}") (filesOf ignoreFile));
    };
}
