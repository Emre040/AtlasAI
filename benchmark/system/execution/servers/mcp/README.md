# ProteinAtlas MCP server

The MCP arm runs the ProteinAtlas MCP server, version 1.0.0, from
https://github.com/Augmented-Nature/ProteinAtlas-MCP-Server. Its licence does
not permit redistribution, so it is not included here. To run the arm:

```bash
git clone https://github.com/Augmented-Nature/ProteinAtlas-MCP-Server .
npm ci && npm run build
```

The runner starts `build/index.js` from this directory (or from `--server-host`
over ssh; see ../../README.md).
