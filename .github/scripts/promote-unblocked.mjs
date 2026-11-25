// Promotes Project items from Backlog → Ready for dev when every issue blocking them (native "blocked by" dependencies) is closed.
//
// Env: PROJECT_URL, REPO (owner/name), GITHUB_TOKEN (fine-grained PAT:
// Projects read/write + Issues read)

const PROJECT_URL = process.env.PROJECT_URL;
const REPO = process.env.REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const FIELD = process.env.STATUS_FIELD ?? "Status";
const FROM = process.env.FROM_COLUMN ?? "Backlog";
const TO = process.env.TO_COLUMN ?? "Ready for dev";
const REQUIRE_DEPS = (process.env.REQUIRE_DEPS ?? "true") === "true";

const [, kind, owner, num] = PROJECT_URL.match(/github\.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/);

const gql = async (query, variables = {}) => {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
};
const rest = async (path) =>
  (await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
  })).json();

// 1. Project + items
const key = kind === "users" ? "user" : "organization";
const data = await gql(`query($o:String!,$n:Int!){
  ${key}(login:$o){ projectV2(number:$n){
    id
    fields(first:30){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } }
    items(first:100){ nodes{ id
      fieldValues(first:10){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ name } } }
      content{ ... on Issue{ number state repository{name} } }
    } }
  } }`, { o: owner, n: +num });
const project = data[key].projectV2;

const field = project.fields.nodes.find(f => f.name === FIELD);
const from = field.options.find(o => o.name === FROM);
const to = field.options.find(o => o.name === TO);
if (!from || !to) throw new Error(`Column not found: ${from ? TO : FROM}`);

// 2. Promote Backlog items whose blockers are all closed
let promoted = 0;
for (const item of project.items.nodes) {
  const status = item.fieldValues.nodes.find(v => v.name)?.name;
  const issue = item.content;
  if (status !== FROM || !issue || issue.state !== "OPEN") continue;

  // native dependencies — list of issues blocking this one
  const blockers = await rest(
    `/repos/${owner}/${issue.repository.name}/issues/${issue.number}/dependencies/blocked_by?per_page=100`
  );
  const list = Array.isArray(blockers) ? blockers : blockers?.issues ?? [];

  if (REQUIRE_DEPS && list.length === 0) continue;   // no dependencies → triaged manually
  if (!list.every(b => b.state === "closed")) continue;

  await gql(`mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
    updateProjectV2ItemFieldValue(input:{ projectId:$p itemId:$i fieldId:$f
      value:{ singleSelectOptionId:$o } }){ projectV2Item{ id } } }`,
    { p: project.id, i: item.id, f: field.id, o: to.id });
  console.log(`Promoted #${issue.number} — all blockers closed`);
  promoted++;
}
console.log(`Done. ${promoted} item(s) promoted.`);
