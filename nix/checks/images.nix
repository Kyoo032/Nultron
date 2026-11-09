# Builds both images under `nix flake check`, so the check proves the whole factory and not only the scripts.
{
  linkFarmFromDrvs,
  web-image,
  portal-image,
}:
linkFarmFromDrvs "nultron-images" [
  web-image
  portal-image
]
