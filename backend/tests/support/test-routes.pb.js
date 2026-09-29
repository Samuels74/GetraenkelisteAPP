// TEST ONLY – copied into the throw-away PocketBase of the API tests by
// setup/global-setup.ts. Never deployed.
//
// Deletes a record with a plain model delete ($app.delete), i.e. without the
// REST record handlers and their request hooks, to prove that the delete
// guards also hold outside of the REST API.

routerAdd(
  "POST",
  "/api/test/model-delete/{collection}/{id}",
  (e) => {
    const record = e.app.findRecordById(e.request.pathValue("collection"), e.request.pathValue("id"));
    e.app.delete(record);
    return e.noContent(204);
  },
  $apis.requireSuperuserAuth(),
);
