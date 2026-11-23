# Hermetic TLA+ / TLC formal check (default + --hazard) over only the files chat-run-settle reads.
{
  runCommand,
  nodejs,
  jre_headless,
  tla2tools,
  workspace-filesets,
}:
runCommand "nultron-ci-formal-chat-settle"
  {
    nativeBuildInputs = [
      nodejs
      jre_headless
    ];
    TLA2TOOLS_JAR = "${tla2tools}";
  }
  ''
    mkdir -p "$TMPDIR/ws" "$TMPDIR/home" "$out"
    export HOME="$TMPDIR/home"
    cp -a ${workspace-filesets.formalChatSettle}/. "$TMPDIR/ws/"
    chmod -R u+w "$TMPDIR/ws"
    cd "$TMPDIR/ws"

    node scripts/formal/chat-run-settle.mjs | tee "$out/default.log"
    node scripts/formal/chat-run-settle.mjs --hazard | tee "$out/hazard.log"
  ''
