# Third-party distribution

ELVION source code is MIT licensed. Third-party code and binaries retain their original licenses.

The Windows platform packages redistribute the complete official PortableGit 2.56.1.windows.1 runtime. This includes Git, GNU Bash, MSYS2 and other components under GPL and other licenses. Preserve all license/copyright/source-offer files supplied by upstream. Do not relabel these components as MIT.

Release must attach the matching complete third-party corresponding-source archive and build materials collected with the upstream `git-for-windows/build-extra` source collection procedure, alongside its SHA-256 manifest. A URL to Git source alone is not a replacement for all bundled component sources. The release workflow deliberately blocks publication if that artifact is absent.

PortableGit official source: https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1
Source collector: https://github.com/git-for-windows/build-extra/blob/main/get-sources.sh

npm dependency licenses are retained in installed packages; `package-lock.json` records exact versions. The package does not run install scripts or download executable code on consumer installation.
