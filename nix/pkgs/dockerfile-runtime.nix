# The image config a Dockerfile's last stage declares, read from the Dockerfile itself, so a Nix image takes its
# ENV, WORKDIR, USER, EXPOSE, VOLUME, HEALTHCHECK and CMD from the file Docker builds from and cannot drift
# from it. Not a derivation.
#
#   (dockerfile-runtime "webapp-deploy/Dockerfile").cmd   => [ "./node_modules/.bin/tsx" "server.ts" ]
#
# Only what those two Dockerfiles use is understood: `\` continuations, `#` comment lines (also inside a
# continuation, as Docker allows), ENV as `key=value` pairs without quotes or spaces, JSON-form CMD and
# VOLUME, shell-form HEALTHCHECK CMD, and durations in s or m. Anything else throws, rather than guess.
{ lib, repoRoot }:
dockerfile:
let
  fail = msg: throw "nix/pkgs/dockerfile-runtime.nix: ${dockerfile}: ${msg}";

  rawLines = lib.splitString "\n" (builtins.readFile (repoRoot + "/${dockerfile}"));

  isComment = line: lib.hasPrefix "#" (lib.trim line);

  # Join `\` continuations into one instruction per entry; comment lines are dropped wherever they sit.
  instructions =
    let
      step =
        acc: line:
        if isComment line || (acc.pending == "" && lib.trim line == "") then
          acc
        else
          let
            trimmed = lib.trimWith { end = true; } line;
            continues = lib.hasSuffix "\\" trimmed;
            text = acc.pending + (if continues then lib.removeSuffix "\\" trimmed else trimmed);
          in
          if continues then
            acc // { pending = text + " "; }
          else
            {
              done = acc.done ++ [ (lib.trim text) ];
              pending = "";
            };
    in
    (lib.foldl' step {
      done = [ ];
      pending = "";
    } rawLines).done;

  keyword = line: lib.toUpper (lib.head (lib.splitString " " line));
  rest = line: lib.trim (lib.removePrefix (lib.head (lib.splitString " " line)) line);

  # The last stage: everything after the last FROM.
  lastStage =
    let
      froms = lib.filter (i: keyword (lib.elemAt instructions i) == "FROM") (
        lib.range 0 (lib.length instructions - 1)
      );
    in
    if froms == [ ] then fail "no FROM" else lib.drop (lib.last froms + 1) instructions;

  of = kw: map rest (lib.filter (line: keyword line == kw) lastStage);
  lastOf =
    kw:
    let
      all = of kw;
    in
    if all == [ ] then fail "no ${kw} in the last stage" else lib.last all;

  words = text: lib.filter (w: w != "") (lib.splitString " " text);

  # In declaration order, as Docker writes them into the image config.
  env = map (
    pair:
    if builtins.match "[A-Za-z_][A-Za-z0-9_]*=[^\"' ]*" pair == null then
      fail "ENV entry `${pair}` is not a plain key=value"
    else
      pair
  ) (lib.concatMap words (of "ENV"));

  seconds =
    value:
    let
      m = builtins.match "([0-9]+)([sm])" value;
    in
    if m == null then
      fail "duration `${value}` is not <n>s or <n>m"
    else
      lib.toInt (lib.elemAt m 0) * (if lib.elemAt m 1 == "m" then 60 else 1);

  healthcheck =
    let
      text = lastOf "HEALTHCHECK";
      parts = builtins.match "(.*)CMD (.*)" text;
      flags = lib.listToAttrs (
        map (
          flag:
          let
            kv = builtins.match "--([a-z-]+)=(.*)" flag;
          in
          if kv == null then
            fail "HEALTHCHECK flag `${flag}`"
          else
            lib.nameValuePair (lib.elemAt kv 0) (lib.elemAt kv 1)
        ) (words (lib.elemAt parts 0))
      );
      ns = name: seconds flags.${name} * 1000000000;
    in
    if parts == null then
      fail "HEALTHCHECK without CMD"
    else
      {
        Test = [
          "CMD-SHELL"
          (lib.trim (lib.elemAt parts 1))
        ];
        Interval = ns "interval";
        Timeout = ns "timeout";
        StartPeriod = ns "start-period";
        Retries = lib.toInt flags.retries;
      };
in
{
  inherit env healthcheck;
  workdir = lastOf "WORKDIR";
  user = lastOf "USER";
  exposedPorts = lib.genAttrs (map (port: "${port}/tcp") (lib.concatMap words (of "EXPOSE"))) (
    _: { }
  );
  volumes = lib.genAttrs (lib.concatMap builtins.fromJSON (of "VOLUME")) (_: { });
  cmd = builtins.fromJSON (lastOf "CMD");
}
