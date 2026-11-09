# The Kubernetes JSON schemas kubeconform validates the rendered manifests against, one file per kind the
# overlays produce, so the check runs with no network. They are yannh/kubernetes-json-schema's standalone strict
# schemas for Kubernetes 1.34, the version the local rehearsal was driven on (webapp-deploy/k8s/README.md), at a
# pinned commit. A kind the manifests start using needs its line here, or kubeconform reports it missing.
{
  lib,
  linkFarm,
  fetchurl,
}:
let
  rev = "102361970337d65537d40141dc29b991b8e95786";
  version = "v1.34.0";
  hashes = {
    "configmap-v1" = "sha256-4Ord69Z3wIqgkrLaImTYasT8NO7RErn6wpRbPwDB6bE=";
    "cronjob-batch-v1" = "sha256-+5Ie2sw97QgMoyIjMZdyf4wRAlS6NRTm+q3l+gZROuQ=";
    "deployment-apps-v1" = "sha256-krejM6SRJPUwAJXT53hsogOLfW5gLDCfc+kGMTd+Swo=";
    "namespace-v1" = "sha256-Mk+uZ3uY0abVQ0DbDDNNBT6P+6/Os/czJuQd4mENWEM=";
    "networkpolicy-networking-v1" = "sha256-9jJMxGT2IiiwQY9DjRZyCOT4bH42d7ow9gjnmosmunk=";
    "persistentvolumeclaim-v1" = "sha256-XsWSy18ATA4k+ggN2E9IuTOc0MgiSKeNN7aj4bTXqzQ=";
    "secret-v1" = "sha256-3nYcywa9HSxkH7Vzl/YbaOf/U6OE8IF85A5d7YzuhvM=";
    "service-v1" = "sha256-i/AZhU2u1RHnwXSJaomBc/pl2I7Fk3xoejcwPUzJNRs=";
    "statefulset-apps-v1" = "sha256-4JWp2Id2+7LpyTErqsMiyZKp9RiPga5pC7fcAPw5Ffo=";
    "storageclass-storage-v1" = "sha256-lwS7iOxz7Tf41WXb0tLuHo7mG17GPJalphkm1pce88k=";
  };
in
linkFarm "nultron-k8s-schemas-${version}" (
  lib.mapAttrsToList (name: hash: {
    name = "${name}.json";
    path = fetchurl {
      url = "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${rev}/${version}-standalone-strict/${name}.json";
      inherit hash;
    };
  }) hashes
)
