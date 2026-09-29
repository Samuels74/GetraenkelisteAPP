/// <reference path="../../.pb/dev-data/types.d.ts" />

// Seed data – see docs/ARCHITECTURE.md §4 "Seed data".
//
// - user "admin" / password "admin" (role admin, must change the password)
// - group "Getränke" with the offerings known from the legacy app
// - app name "Getränkeliste"

migrate((app) => {
  const OFFERINGS = [
    "Bier/Wein",
    "Redbull",
    "Murelli",
    "Mineralwasser",
    "Fruchtsäfte",
    "Kaffee",
    "Pfand",
  ];

  const findFirst = (collection, key, value) => {
    try {
      return app.findFirstRecordByData(collection, key, value);
    } catch (_) {
      return null;
    }
  };

  // ------------------------------------------------------------ admin user
  if (!findFirst("users", "username", "admin")) {
    const admin = new Record(app.findCollectionByNameOrId("users"));
    admin.set("username", "admin");
    admin.set("role", "admin");
    admin.set("mustChangePassword", true);
    admin.set("disabled", false);
    admin.setPassword("admin");

    // "admin" is shorter than the 8 characters required for every password
    // set through the API. The seed intentionally bypasses the record
    // validation (login does not re-validate the password length).
    app.saveNoValidate(admin);
  }

  // ------------------------------------------------- group + its offerings
  let drinks = findFirst("groups", "name", "Getränke");
  if (!drinks) {
    drinks = new Record(app.findCollectionByNameOrId("groups"));
    drinks.set("name", "Getränke");
    drinks.set("sortOrder", 10);
    app.save(drinks);

    const offerings = app.findCollectionByNameOrId("offerings");
    OFFERINGS.forEach((name, i) => {
      const offering = new Record(offerings);
      offering.set("name", name);
      offering.set("group", drinks.id);
      offering.set("priceCents", 0);
      offering.set("active", true);
      offering.set("sortOrder", (i + 1) * 10);
      app.save(offering);
    });
  }

  // -------------------------------------------------------------- settings
  const settings = app.settings();
  settings.meta.appName = "Getränkeliste";
  app.save(settings);
}, (app) => {
  const findFirst = (collection, key, value) => {
    try {
      return app.findFirstRecordByData(collection, key, value);
    } catch (_) {
      return null;
    }
  };

  // Seeded records are only removed as long as they are not referenced
  // (the delete guards in pb_hooks reject deleting referenced records).
  const drinks = findFirst("groups", "name", "Getränke");
  if (drinks) {
    for (const offering of app.findRecordsByFilter(
      "offerings",
      "group = {:group}",
      "",
      0,
      0,
      { group: drinks.id },
    )) {
      app.delete(offering);
    }
    app.delete(drinks);
  }

  const admin = findFirst("users", "username", "admin");
  if (admin) {
    app.delete(admin);
  }

  const settings = app.settings();
  settings.meta.appName = "Acme";
  app.save(settings);
});
