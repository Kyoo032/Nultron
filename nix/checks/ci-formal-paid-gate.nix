# Hermetic paid-media gate (SR-167) formal property + AST reach check.
{ ci-pkg-step, workspace-filesets }:
ci-pkg-step {
  name = "formal-paid-gate";
  src = workspace-filesets.formalPaidGate;
  command = ''
    node .cursor/skills/verify-paid-media-gate/scripts/check.mjs 2>&1 | tee "$TMPDIR/step.log"
  '';
}
