// Patches the compiled v0.25.44 webapp so the Delete Workspace dialog shows
// the server's real error. The dialog reads `error.response.data`, which is
// the axios shape, but this build's API client throws openapi-typescript-fetch
// ApiError objects, which carry the body on `error.data`. So every failure
// fell through to the generic "Cannot delete workspace" toast.
// Each anchor must match exactly once, so an upstream rebuild fails the
// image build instead of shipping a half-patched bundle.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
const files = fs.readdirSync(dir);
const one = (re) => {
  const m = files.filter((f) => re.test(f));
  if (m.length !== 1) throw new Error(`expected one ${re}, found ${m.join(',') || 'none'}`);
  return path.join(dir, m[0]);
};

const patches = [
  {
    file: one(/^PrivatePages-(?!legacy)[\w-]+\.js$/),
    edits: [
      ['(y=C==null?void 0:C.response)==null?void 0:y.data', '(y=C==null?void 0:(C.response||C))==null?void 0:y.data'],
      ['(h=C==null?void 0:C.response)==null?void 0:h.data', '(h=C==null?void 0:(C.response||C))==null?void 0:h.data'],
    ],
  },
  {
    file: one(/^PrivatePages-legacy-[\w-]+\.js$/),
    edits: [
      ['const a=t?.response?.data?.errors?.[0]?.type,n="CANNOT_DELETE_CURRENT_ORGANIZATION"===a',
       'const a=(t?.response||t)?.data?.errors?.[0]?.type,n="CANNOT_DELETE_CURRENT_ORGANIZATION"===a'],
      [':t?.response?.data?.errors?.[0]?.message||St.get("workspaces.cannot_delete_workspace"',
       ':(t?.response||t)?.data?.errors?.[0]?.message||St.get("workspaces.cannot_delete_workspace"'],
    ],
  },
];

for (const { file, edits } of patches) {
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of edits) {
    const n = src.split(from).length - 1;
    if (n !== 1) throw new Error(`${path.basename(file)}: anchor matched ${n} times: ${from}`);
    src = src.replace(from, to);
  }
  fs.writeFileSync(file, src);
  console.log(`patched ${path.basename(file)} (${edits.length} edits)`);
}
