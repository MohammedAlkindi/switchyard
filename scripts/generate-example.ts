import { writeFile } from "node:fs/promises";
import { makeReviewFixture } from "../tests/review-fixture.js";
const report = await makeReviewFixture();
await writeFile(
  new URL("../public/example.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
