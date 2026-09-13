// Twenty workspace schema additions the mirror relies on. Idempotent — run it once per
// workspace and again after upgrading this repo; existing fields/options are left alone.
//
//   node skills/m8-crm-sync/scripts/schema-extend.ts
//
// Assumes the base pipeline fields already exist on the workspace (company.outreachStatus,
// company.route, person.sequenceStatus, …). Adds what M8 push/audit read and write on top:
//   - person.sequenceStep (TEXT) — Apollo's "2/5 (auto_email)" style step string
//   - company.route SELECT: created with QUALIFIED / SKIP / FLAGGED if the field is missing,
//     else each option is appended if absent. DROPPED is store-only and never mirrored, so it
//     is deliberately NOT a CRM option.
//   - company.outreachStatus += FINISHED; person.sequenceStatus += FAILED (Apollo reports
//     "failed" on a send failure such as an unverified address — mirror it truthfully)
import { metaGql } from "../../../lib/twenty.ts";

const objsRes = await metaGql(`query {
  objects(paging: { first: 100 }) {
    edges { node { id nameSingular fields(paging: { first: 300 }) { edges { node { id name options } } } } }
  }
}`);
if (objsRes.errors) {
  console.error("metadata query failed:", JSON.stringify(objsRes.errors).slice(0, 500));
  process.exit(1);
}
const objects = objsRes.data.objects.edges.map((e: any) => e.node);
const byName: Record<string, any> = Object.fromEntries(objects.map((o: any) => [o.nameSingular, o]));

const sel = (label: string, value: string, position: number, color: string) => ({ label, value, position, color });

const ROUTE_OPTIONS = [
  sel("Qualified", "QUALIFIED", 0, "green"),
  sel("Skip", "SKIP", 1, "gray"),
  sel("Flagged", "FLAGGED", 2, "orange"),
];

const NEW_FIELDS: Array<{ obj: string; input: any }> = [
  { obj: "company", input: { name: "route", label: "Route", type: "SELECT", options: ROUTE_OPTIONS } },
  { obj: "person", input: { name: "sequenceStep", label: "Sequence Step", type: "TEXT" } },
];

for (const f of NEW_FIELDS) {
  const obj = byName[f.obj];
  if (!obj) { console.log(`MISSING object ${f.obj} — skipped ${f.input.name}`); continue; }
  const existing = obj.fields.edges.map((e: any) => e.node.name);
  if (existing.includes(f.input.name)) { console.log(`exists: ${f.obj}.${f.input.name}`); continue; }
  const r = await metaGql(
    `mutation CreateField($input: CreateOneFieldMetadataInput!) { createOneField(input: $input) { id name } }`,
    { input: { field: { objectMetadataId: obj.id, ...f.input } } },
  );
  console.log(r.errors ? `FAIL ${f.obj}.${f.input.name}: ${JSON.stringify(r.errors).slice(0, 300)}` : `created: ${f.obj}.${f.input.name}`);
  if (!r.errors && f.input.type === "SELECT") {
    // Re-read so the option loop below sees the field it just created.
    obj.fields.edges.push({ node: { id: r.data?.createOneField?.id, name: f.input.name, options: f.input.options } });
  }
}

// SELECT option additions — appended at the end of the existing option list.
const OPTION_ADDS: Array<{ obj: string; field: string; option: { label: string; value: string; color: string } }> = [
  { obj: "company", field: "outreachStatus", option: { label: "Finished", value: "FINISHED", color: "blue" } },
  { obj: "person", field: "sequenceStatus", option: { label: "Failed", value: "FAILED", color: "red" } },
  ...ROUTE_OPTIONS.map((o) => ({ obj: "company", field: "route", option: { label: o.label, value: o.value, color: o.color } })),
];

for (const add of OPTION_ADDS) {
  const obj = byName[add.obj];
  if (!obj) { console.log(`MISSING object ${add.obj} — skipped ${add.field}`); continue; }
  const field = obj.fields.edges.map((e: any) => e.node).find((n: any) => n.name === add.field);
  if (!field) { console.log(`MISSING field ${add.obj}.${add.field}`); continue; }
  if ((field.options ?? []).some((o: any) => o.value === add.option.value)) {
    console.log(`${add.obj}.${add.field}: ${add.option.value} exists`);
    continue;
  }
  const options = [
    ...(field.options ?? []).map((o: any) => ({ id: o.id, label: o.label, value: o.value, position: o.position, color: o.color })),
    { ...add.option, position: (field.options ?? []).length },
  ];
  const r = await metaGql(
    `mutation($input: UpdateOneFieldMetadataInput!) { updateOneField(input: $input) { id } }`,
    { input: { id: field.id, update: { options } } },
  );
  if (!r.errors) field.options = options;
  console.log(`${add.obj}.${add.field} += ${add.option.value}:`, r.errors ? JSON.stringify(r.errors).slice(0, 300) : "ok");
}

console.log("schema-extend complete");
