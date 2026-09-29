/// <reference path="../../.pb/dev-data/types.d.ts" />

// Initial schema – see docs/ARCHITECTURE.md §4.
//
// - reshapes the default "users" auth collection (username login, role,
//   mustChangePassword, disabled; email optional + hidden; no avatar)
// - creates "groups", "offerings", "persons" and "bookings"
//
// Every collection has autodate "created"/"updated" fields, relations never
// cascade on delete, and case-insensitive uniqueness is enforced through
// unique indexes with COLLATE NOCASE.
//
// Note: the data passed to `new Collection({...})` is unmarshaled from JSON,
// therefore the fields are declared as plain objects with a "type" key.

migrate((app) => {
  const AUTHENTICATED = '@request.auth.id != ""';
  const ADMIN = '@request.auth.role = "admin"';

  const autodateFields = () => [
    { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
  ];

  // ---------------------------------------------------------------- users
  const users = app.findCollectionByNameOrId("users");

  users.fields.removeByName("avatar");

  const email = users.fields.getByName("email");
  email.required = false;
  email.hidden = true;

  users.fields.getByName("name").max = 100;

  // insert the app specific fields right before the autodate fields
  const createdPos = users.fields.fieldNames().indexOf("created");
  users.fields.addAt(
    createdPos >= 0 ? createdPos : users.fields.fieldNames().length,
    new TextField({
      name: "username",
      required: true,
      min: 3,
      max: 32,
      pattern: "^[a-z0-9._-]+$",
      presentable: true,
    }),
    new SelectField({
      name: "role",
      required: true,
      maxSelect: 1,
      values: ["admin", "user"],
    }),
    new BoolField({ name: "mustChangePassword" }),
    new BoolField({ name: "disabled" }),
  );

  users.addIndex("idx_users_username", true, "`username` COLLATE NOCASE", "");

  // Own record: only name + password (password/passwordConfirm/oldPassword) may
  // change. Sending an unchanged value of a protected field is tolerated.
  const ownRecordOnlyNameOrPassword = [
    "id = @request.auth.id",
    "(@request.body.username:isset = false || @request.body.username = username)",
    "(@request.body.role:isset = false || @request.body.role = role)",
    "(@request.body.disabled:isset = false || @request.body.disabled = disabled)",
    "(@request.body.mustChangePassword:isset = false || @request.body.mustChangePassword = mustChangePassword)",
    "@request.body.email:isset = false",
    "@request.body.emailVisibility:isset = false",
    "@request.body.verified:isset = false",
  ].join(" && ");

  unmarshal(
    {
      listRule: AUTHENTICATED,
      viewRule: AUTHENTICATED,
      createRule: ADMIN,
      updateRule: `${ADMIN} || (${ownRecordOnlyNameOrPassword})`,
      deleteRule: `${ADMIN} && id != @request.auth.id`,
      manageRule: ADMIN,
      authRule: "disabled = false",
      passwordAuth: { enabled: true, identityFields: ["username"] },
      oauth2: { enabled: false, mappedFields: { avatarURL: "", username: "" } },
      otp: { enabled: false },
      mfa: { enabled: false },
      authAlert: { enabled: false },
    },
    users,
  );

  app.save(users);

  // --------------------------------------------------------------- groups
  const groups = new Collection({
    type: "base",
    name: "groups",
    listRule: AUTHENTICATED,
    viewRule: AUTHENTICATED,
    createRule: ADMIN,
    updateRule: ADMIN,
    deleteRule: ADMIN,
    fields: [
      { type: "text", name: "name", required: true, max: 50, presentable: true },
      { type: "number", name: "sortOrder", onlyInt: true },
      ...autodateFields(),
    ],
    indexes: ["CREATE UNIQUE INDEX `idx_groups_name` ON `groups` (`name` COLLATE NOCASE)"],
  });
  app.save(groups);

  // ------------------------------------------------------------ offerings
  const offerings = new Collection({
    type: "base",
    name: "offerings",
    listRule: AUTHENTICATED,
    viewRule: AUTHENTICATED,
    createRule: ADMIN,
    updateRule: ADMIN,
    deleteRule: ADMIN,
    fields: [
      { type: "text", name: "name", required: true, max: 50, presentable: true },
      {
        type: "relation",
        name: "group",
        required: true,
        collectionId: groups.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: "number", name: "priceCents", onlyInt: true, min: -100000, max: 100000 },
      { type: "bool", name: "active" },
      { type: "number", name: "sortOrder", onlyInt: true },
      ...autodateFields(),
    ],
    indexes: [
      "CREATE UNIQUE INDEX `idx_offerings_group_name` ON `offerings` (`group`, `name` COLLATE NOCASE)",
    ],
  });
  app.save(offerings);

  // -------------------------------------------------------------- persons
  const persons = new Collection({
    type: "base",
    name: "persons",
    listRule: AUTHENTICATED,
    viewRule: AUTHENTICATED,
    createRule: AUTHENTICATED,
    updateRule: AUTHENTICATED,
    deleteRule: ADMIN,
    fields: [
      {
        type: "text",
        name: "number",
        required: true,
        max: 20,
        pattern: "^[A-Za-z0-9_-]+$",
        presentable: true,
      },
      { type: "text", name: "name", max: 100 },
      { type: "text", name: "nickname", max: 100 },
      ...autodateFields(),
    ],
    indexes: ["CREATE UNIQUE INDEX `idx_persons_number` ON `persons` (`number` COLLATE NOCASE)"],
  });
  app.save(persons);

  // ------------------------------------------------------------- bookings
  const relation = (name, collectionId) => ({
    type: "relation",
    name,
    required: true,
    collectionId,
    cascadeDelete: false,
    maxSelect: 1,
  });

  const bookings = new Collection({
    type: "base",
    name: "bookings",
    listRule: AUTHENTICATED,
    viewRule: AUTHENTICATED,
    createRule: '@request.auth.id != "" && @request.auth.collectionName = "users"',
    updateRule: null, // superusers only
    deleteRule: `${ADMIN} || createdBy = @request.auth.id`,
    fields: [
      relation("person", persons.id),
      relation("offering", offerings.id),
      { type: "number", name: "quantity", required: true, onlyInt: true, min: 1, max: 99 },
      { type: "number", name: "unitPriceCents", onlyInt: true, min: -100000, max: 100000 },
      relation("createdBy", users.id),
      ...autodateFields(),
    ],
    indexes: [
      "CREATE INDEX `idx_bookings_person` ON `bookings` (`person`)",
      "CREATE INDEX `idx_bookings_offering` ON `bookings` (`offering`)",
      "CREATE INDEX `idx_bookings_createdBy` ON `bookings` (`createdBy`)",
      "CREATE INDEX `idx_bookings_created` ON `bookings` (`created`)",
    ],
  });
  app.save(bookings);
}, (app) => {
  // drop the app collections (reverse dependency order)
  for (const name of ["bookings", "persons", "offerings", "groups"]) {
    let collection = null;
    try {
      collection = app.findCollectionByNameOrId(name);
    } catch (_) {
      continue; // already gone
    }
    app.delete(collection);
  }

  // restore the default "users" collection shape
  const users = app.findCollectionByNameOrId("users");

  users.removeIndex("idx_users_username");
  for (const name of ["username", "role", "mustChangePassword", "disabled"]) {
    users.fields.removeByName(name);
  }

  const email = users.fields.getByName("email");
  email.required = true;
  email.hidden = false;

  users.fields.getByName("name").max = 255;

  const createdPos = users.fields.fieldNames().indexOf("created");
  users.fields.addAt(
    createdPos >= 0 ? createdPos : users.fields.fieldNames().length,
    new FileField({
      name: "avatar",
      maxSelect: 1,
      mimeTypes: ["image/jpeg", "image/png", "image/svg+xml", "image/gif", "image/webp"],
    }),
  );

  unmarshal(
    {
      listRule: "id = @request.auth.id",
      viewRule: "id = @request.auth.id",
      createRule: "",
      updateRule: "id = @request.auth.id",
      deleteRule: "id = @request.auth.id",
      manageRule: null,
      authRule: "",
      passwordAuth: { enabled: true, identityFields: ["email"] },
      oauth2: { mappedFields: { avatarURL: "avatar" } },
      authAlert: { enabled: true },
    },
    users,
  );

  app.save(users);
});
