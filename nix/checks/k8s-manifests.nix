# Renders the kustomize base and both overlays with the pinned kustomize and validates every object with
# kubeconform (strict) against pinned Kubernetes 1.34 schemas (k8s-schemas.nix). The manifests are read as
# committed; the rendered YAML is the check's output.
#
# The overlays read what git never holds: secrets.env (both overlays) and, for the local one, the throwaway PKI
# that rehearse-local.mjs generates. The check makes the same shape from the committed secrets.env.example
# files and a certificate made here for the occasion; nothing it renders is ever applied.
#
# The local overlay is rendered as committed, with the base's image names. The rehearsal applies a generated
# overlay around it that pins the local image tags (k8s/local-lib.mjs, generatedKustomization), which this
# check does not reproduce.
{
  runCommand,
  kustomize,
  kubeconform,
  openssl,
  k8s-schemas,
  repoRoot,
}:
runCommand "nultron-k8s-manifests"
  {
    nativeBuildInputs = [
      kustomize
      kubeconform
      openssl
    ];
  }
  ''
    cp -r ${repoRoot + "/webapp-deploy/k8s"} k8s
    chmod -R u+w k8s

    for overlay in local production; do
      cp "k8s/overlays/$overlay/secrets.env.example" "k8s/overlays/$overlay/secrets.env"
    done

    mkdir -p k8s/overlays/local/pki
    for name in ca edge mailpit; do
      openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=nultron-$name-throwaway" \
        -keyout "k8s/overlays/local/pki/$name.key" -out "k8s/overlays/local/pki/$name.crt" 2> /dev/null
    done

    mkdir -p "$out"
    for target in base overlays/local overlays/production; do
      rendered="$out/$(echo "$target" | tr / -).yaml"
      kustomize build "k8s/$target" > "$rendered"
      echo "== $target: $(grep -c '^kind:' "$rendered") objects"
      kubeconform -strict -summary \
        -schema-location '${k8s-schemas}/{{ .ResourceKind }}{{ .KindSuffix }}.json' \
        "$rendered"
    done
  ''
