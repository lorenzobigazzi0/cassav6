import test from "node:test";
import assert from "node:assert/strict";
import {
  areIntegrationTablesLinkedByGroup,
  collectIntegrationTableGroupLeafIds,
  findIntegrationTableGroupContaining,
  formatIntegrationTableNumberGroupLabel,
  resolveIntegrationLinkedTableIds,
  resolveIntegrationLogicalTableLabel,
  sanitizeIntegrationTableGroupNode,
  sanitizeIntegrationTableGroups,
  sanitizeIntegrationTableLabel,
} from "../modules/integration/table-groups.domain.js";

const TABLES = [
  { id: "room_gazebo_t01", number: 1 },
  { id: "room_gazebo_t02", number: 2 },
  { id: "room_gazebo_t03", number: 3 },
];

test("table groups normalizza nodi complessi, deduplica figli e conserva foglie", () => {
  const node = sanitizeIntegrationTableGroupNode({
    id: "group_gazebo",
    children: [
      { id: "room_gazebo_t01" },
      { id: "room_gazebo_t01" },
      { id: "room_gazebo_t02" },
    ],
  });

  assert.deepEqual(node, {
    id: "group_gazebo",
    type: "complex",
    children: [
      { id: "room_gazebo_t01", type: "simple" },
      { id: "room_gazebo_t02", type: "simple" },
    ],
  });
  assert.deepEqual([...collectIntegrationTableGroupLeafIds(node)], ["room_gazebo_t01", "room_gazebo_t02"]);
});

test("table groups scarta gruppi sovrapposti, invalidi e oltre validIds", () => {
  const groups = sanitizeIntegrationTableGroups(
    [
      { id: "group_a", children: [{ id: "room_gazebo_t01" }, { id: "room_gazebo_t02" }] },
      { id: "group_b", children: [{ id: "room_gazebo_t02" }, { id: "room_gazebo_t03" }] },
      { id: "group_invalid_single", children: [{ id: "room_missing" }] },
    ],
    {
      validIds: new Set(["group_a", "group_b", "group_invalid_single", "room_gazebo_t01", "room_gazebo_t02", "room_gazebo_t03"]),
      nowIso: () => "2026-06-05T10:00:00.000Z",
    }
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "group_a");
  assert.equal(groups[0].updatedAt, "2026-06-05T10:00:00.000Z");
});

test("table groups risolve label logica e link fra tavoli", () => {
  const integration = {
    tableGroups: [
      { id: "group_gazebo", children: [{ id: "room_gazebo_t01" }, { id: "room_gazebo_t03" }] },
    ],
  };
  const settings = { tables: TABLES };

  assert.equal(resolveIntegrationLogicalTableLabel(settings, integration, "room_gazebo_t01", 9), "1/3");
  assert.equal(resolveIntegrationLogicalTableLabel(settings, integration, "room_gazebo_t02", 2), "2");
  assert.equal(findIntegrationTableGroupContaining(integration, "room_gazebo_t03")?.id, "group_gazebo");
  assert.equal(areIntegrationTablesLinkedByGroup(integration, "room_gazebo_t01", "room_gazebo_t03"), true);
  assert.equal(areIntegrationTablesLinkedByGroup(integration, "room_gazebo_t01", "room_gazebo_t02"), false);
  assert.deepEqual(resolveIntegrationLinkedTableIds(integration, "room_gazebo_t01"), [
    "group_gazebo",
    "room_gazebo_t01",
    "room_gazebo_t03",
  ]);
});

test("table groups helpers formattano label tavolo", () => {
  assert.equal(sanitizeIntegrationTableLabel(" Tavolo  12 bis "), "Tavolo 12 bis");
  assert.equal(sanitizeIntegrationTableLabel("Tavolo 12"), "12");
  assert.equal(formatIntegrationTableNumberGroupLabel([3, 1, 3, 2, "x"]), "1/2/3");
});
