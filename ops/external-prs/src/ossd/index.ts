import tmp from "tmp-promise";
import { fileURLToPath } from "node:url";
import { Argv } from "yargs";
import { handleError } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { BaseArgs } from "../base.js";
import { loadData, Project, Collection } from "oss-directory";
import duckdb from "duckdb";
import * as util from "util";
import * as fs from "fs";
import * as fsPromise from "fs/promises";
import * as path from "path";
import * as repl from "repl";
import columnify from "columnify";
import mustache from "mustache";
import {
  EVMNetworkValidator,
  EthereumValidator,
  OptimismValidator,
} from "@opensource-observer/oss-artifact-validators";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Should map to the tables field in ./metadata/databases/databases.yaml

function jsonlExport<T>(path: string, arr: Array<T>): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(path, "utf-8");
    for (const item of arr) {
      stream.write(JSON.stringify(item));
      stream.write("\n");
    }
    stream.close((err) => {
      if (err) {
        return reject(err);
      }
      return resolve();
    });
  });
}

export function ossdSubcommands(yargs: Argv) {
  yargs.command<OSSDirectoryPullRequestArgs>(
    "list-changes <pr> <sha> <main-path> <pr-path>",
    "list changes for an OSSD PR",
    (yags) => {
      yags.positional("pr", {
        type: "number",
        description: "pr number",
      });
      yags.positional("sha", {
        type: "string",
        description: "The sha of the pull request",
      });
      yags.positional("main-path", {
        type: "string",
        description: "The path to the main branch checkout",
      });
      yags.positional("path-path", {
        type: "string",
        description: "The path to the pr checkout",
      });
      yags.option("repl", {
        type: "boolean",
        description: "Start a repl for exploration on the data",
        default: false,
      });
      yags.boolean("repl");
      yags.option("duckdb-path", {
        type: "string",
        description: "The duckdb path. Defaults to using in memory storage",
      });
    },
    (args) => handleError(listPR(args)),
  );
  yargs.command<OSSDirectoryPullRequestArgs>(
    "validate-pr <pr> <sha> <main-path> <pr-path>",
    "Validate changes for an OSSD PR",
    (yags) => {
      yags.positional("pr", {
        type: "number",
        description: "pr number",
      });
      yags.positional("sha", {
        type: "string",
        description: "The sha of the pull request",
      });
      yags.positional("main-path", {
        type: "string",
        description: "The path to the main branch checkout",
      });
      yags.positional("path-path", {
        type: "string",
        description: "The path to the pr checkout",
      });
      yags.option("repl", {
        type: "boolean",
        description: "Start a repl for exploration on the data",
        default: false,
      });
      yags.boolean("repl");
      yags.option("duckdb-path", {
        type: "string",
        description: "The duckdb path. Defaults to using in memory storage",
      });
    },
    (args) => handleError(validatePR(args)),
  );
}

interface OSSDirectoryPullRequestArgs extends BaseArgs {
  pr: number;
  sha: string;
  mainPath: string;
  prPath: string;
  repl: boolean;
  duckdbPath: string;
}

function relativeDir(...args: string[]) {
  return path.join(__dirname, ...args);
}

async function runParameterizedQuery(
  db: duckdb.Database,
  name: string,
  params?: Record<string, unknown>,
) {
  params = params || {};
  const queryPath = relativeDir("queries", `${name}.sql`);
  const query = await renderMustacheFromFile(queryPath, params);
  logger.info({
    message: "running query",
    query: query,
  });
  const dbAll = util.promisify(db.all.bind(db));
  return dbAll(query);
}

async function renderMustacheFromFile(
  filePath: string,
  params?: Record<string, unknown>,
) {
  const raw = await fsPromise.readFile(filePath, "utf-8");
  return mustache.render(raw, params);
}

// | Projects             | {{ projects.existing }} {{ projects.added }} | {{projects.removed}} | {{ projects.updated }}
type ProjectSummary = {
  project_slug: string;
  status: string;
  blockchain_added: number;
  blockchain_removed: number;
  blockchain_unchanged: number;
  blockchain_unique_added: number;
  blockchain_unique_removed: number;
  blockchain_unique_unchanged: number;
  code_added: number;
  code_removed: number;
  code_unchanged: number;
  package_added: number;
  package_removed: number;
  package_unchanged: number;
};

type CodeStatus = {
  project_slug: string;
  code_url: string;
  status: string;
};

type PackageStatus = {
  project_slug: string;
  package_url: string;
  status: string;
};

type BlockchainStatus = {
  project_slug: string;
  address: string;
  tag: string;
  network: string;
  project_relation_status: string;
  address_status: string;
  network_status: string;
  network_tag_status: string;
};

type BlockchainValidationItem = {
  address: string;
  tags: string[];
  networks: string[];
};

type Summary = {
  added: number;
  removed: number;
  existing: number;
};

// type BlockchainSummary = Summary & {
//   unique_added: number;
//   removed_number: number;
// }

type ChangeSummary = {
  projects: ProjectSummary[];
  artifacts: {
    summary: {
      blockchain: Summary;
      package: Summary;
      code: Summary;
    };
    status: {
      blockchain: BlockchainStatus[];
      package: PackageStatus[];
      code: CodeStatus[];
    };
    toValidate: {
      blockchain: BlockchainValidationItem[];
    };
  };
};

class OSSDirectoryPullRequest {
  private db: duckdb.Database;
  private args: OSSDirectoryPullRequestArgs;
  private changes: ChangeSummary;
  private validators: Record<string, EVMNetworkValidator>;

  static async init(args: OSSDirectoryPullRequestArgs) {
    const pr = new OSSDirectoryPullRequest(args);
    await pr.initialize();
    return pr;
  }

  private constructor(args: OSSDirectoryPullRequestArgs) {
    this.args = args;
    this.validators = {};
  }

  async loadValidators() {
    const optimismRpc = process.env.OPTIMISM_RPC_URL;
    const mainnetRpc = process.env.MAINNET_RPC_URL;

    if (!optimismRpc || !mainnetRpc) {
      throw new Error("RPC URLs are required to do validation");
    }

    this.validators["optimism"] = OptimismValidator({
      rpcUrl: optimismRpc,
    });

    this.validators["mainnet"] = EthereumValidator({
      rpcUrl: mainnetRpc,
    });
  }

  async dbAll(query: string) {
    const dbAll = util.promisify(this.db.all.bind(this.db));
    return await dbAll(query);
  }

  async runParameterizedQuery(name: string, params?: Record<string, unknown>) {
    params = params || {};
    const queryPath = relativeDir("queries", `${name}.sql`);
    const query = await renderMustacheFromFile(queryPath, params);
    logger.info({
      message: "running query",
      query: query,
    });
    return this.dbAll(query);
  }

  // Run query with pretty output
  async runQuery(query: string, includeResponse: boolean = false) {
    const res = await this.dbAll(query);
    console.log("");
    console.log(
      columnify(res as Record<string, any>[], {
        truncate: true,
        maxWidth: 20,
      }),
    );
    console.log("");
    if (!includeResponse) {
      return;
    } else {
      return res;
    }
  }

  private async initialize() {
    const args = this.args;

    logger.info({
      message: "setting up the pull request for comparison",
      repo: args.repo,
      sha: args.sha,
      pr: args.pr,
    });

    //const app = args.app;

    const main = await loadData(args.mainPath);
    const pr = await loadData(args.prPath);

    const duckdbPath = args.duckdbPath || ":memory:";

    const db = new duckdb.Database(duckdbPath);
    this.db = db;

    const tablesToCompare: { [table: string]: Project[] | Collection[] } = {
      main_projects: main.projects,
      main_collections: main.collections,
      pr_projects: pr.projects,
      pr_collections: pr.collections,
    };

    return tmp.withDir(
      async (t) => {
        for (const table in tablesToCompare) {
          const dumpPath = path.resolve(path.join(t.path, `${table}.json`));
          await jsonlExport(dumpPath, tablesToCompare[table]);
          // Dump the data into the work path as JSONL files
          //const arrowTable = arrow.tableFromJSON(JSON.parse(JSON.stringify(tablesToCompare[table])));

          const res = await this.dbAll(`
            CREATE TABLE ${table} AS
            SELECT *
            FROM read_json_auto('${dumpPath}');
          `);
          logger.info({
            message: "created table",
            tableName: table,
            queryResponse: res,
          });
        }

        // Implement a poor man's dbt. We should just use dbt but this will work
        // for now without muddying up more things with python + javascript
        // requirements
        await this.runParameterizedQuery("projects_by_collection", {
          source: "main",
        });
        await this.runParameterizedQuery("projects_by_collection", {
          source: "pr",
        });
        await this.runParameterizedQuery("blockchain_artifacts", {
          source: "main",
        });
        await this.runParameterizedQuery("blockchain_artifacts", {
          source: "pr",
        });
        await this.runParameterizedQuery("code_artifacts", {
          source: "main",
        });
        await this.runParameterizedQuery("code_artifacts", {
          source: "pr",
        });
        await this.runParameterizedQuery("package_artifacts", {
          source: "main",
        });
        await this.runParameterizedQuery("package_artifacts", {
          source: "pr",
        });

        await this.runParameterizedQuery("project_status");
        await this.runParameterizedQuery("projects_by_collection_status");
        await this.runParameterizedQuery("blockchain_status");
        await this.runParameterizedQuery("package_status");
        await this.runParameterizedQuery("code_status");
        await this.runParameterizedQuery("artifacts_summary");
        await this.runParameterizedQuery("project_summary");

        const artifactsSummary = (await this.runQuery(
          "SELECT * FROM artifacts_summary",
          true,
        )) as {
          type: string;
          status: string;
          count: number;
          unique_count: number;
        }[];
        const summaries: Record<string, Summary> = {};
        for (const row of artifactsSummary) {
          if (!summaries[row.type]) {
            summaries[row.type] = {
              added: row.status == "ADDED" ? row.count : 0,
              removed: row.status == "REMOVED" ? row.count : 0,
              existing: row.status == "EXISTING" ? row.count : 0,
            };
          } else {
            if (row.status == "ADDED") {
              summaries[row.type].added = row.count;
            } else if (row.type == "REMOVED") {
              summaries[row.type].removed = row.count;
            } else {
              summaries[row.type].existing = row.count;
            }
          }
        }

        const changes: ChangeSummary = {
          projects: (await runParameterizedQuery(
            db,
            "changed_projects",
          )) as ProjectSummary[],
          artifacts: {
            summary: {
              blockchain: summaries["BLOCKCHAIN"],
              code: summaries["CODE"],
              package: summaries["PACKAGE"],
            },
            status: {
              blockchain: (await runParameterizedQuery(
                db,
                "changed_blockchain_artifacts",
              )) as BlockchainStatus[],
              code: (await runParameterizedQuery(
                db,
                "changed_code_artifacts",
              )) as CodeStatus[],
              package: (await runParameterizedQuery(
                db,
                "changed_package_artifacts",
              )) as PackageStatus[],
            },
            toValidate: {
              blockchain: (await runParameterizedQuery(
                db,
                "changed_blockchain_artifacts_to_validate",
              )) as BlockchainValidationItem[],
            },
          },
        };
        this.changes = changes;

        // For simple debugging purposes we provide a REPL to explore the data.
        if (args.repl) {
          const server = repl.start();
          server.context.$db = {
            // Setup raw access to the duckdb api via db
            raw: db,
            // Setup a convenience command that runs queries
            $: async (query: string) => {
              await this.runQuery(query);
            },
            $$: async (query: string) => {
              return await this.runQuery(query, true);
            },
          };
          server.context.changes = changes;
          await new Promise<void>((resolve, reject) => {
            server.on("exit", () => {
              resolve();
            });
            server.on("SIGINT", () => {
              reject(new Error("SIGINT?"));
            });
          });
        }
      },
      { unsafeCleanup: true },
    );
  }

  async list() {
    logger.info(
      "Enumerate the changes as a comment on the PR - without full bigquery access",
    );
    const args = this.args;

    const unchangedProjects = (await this.runParameterizedQuery(
      "unchanged_projects",
    )) as {
      total: number;
    }[];

    const unchangedProjectsCount =
      unchangedProjects.length === 0 ? 0 : unchangedProjects.length;
    const updatedProjectsCount = this.changes.projects.length;

    await args.appUtils.leaveCommentOnPr(
      args.pr,
      await renderMustacheFromFile(relativeDir("messages", "list-changes.md"), {
        projects: {
          added: updatedProjectsCount,
          removed: 0,
          unchanged: unchangedProjectsCount,
        },
        artifacts: this.changes.artifacts.summary,
      }),
    );
  }

  async validate() {
    const args = this.args;
    logger.info({
      message: "validating the pull request",
      repo: args.repo,
      sha: args.sha,
      pr: args.pr,
    });
    await this.loadValidators();

    const validationErrors: { address: string; error: string }[] = [];

    for (const item of this.changes.artifacts.toValidate.blockchain) {
      const address = item.address;
      for (const network of item.networks) {
        const validator = this.validators[network];
        logger.info({
          message: "validating address",
          address: address,
          network: network,
          tags: item.tags,
        });
        if (item.tags.indexOf("eoa") !== -1) {
          if (!(await validator.isEOA(address))) {
            validationErrors.push({
              address: address,
              error: "is not an EOA",
            });
          }
        }
        if (item.tags.indexOf("contract") !== -1) {
          if (!(await validator.isContract(address))) {
            validationErrors.push({
              address: address,
              error: "is not a Contract",
            });
          }
        }
        if (item.tags.indexOf("deployer") !== -1) {
          if (!(await validator.isDeployer(address))) {
            validationErrors.push({
              address: address,
              error: "is not a Deployer",
            });
          }
        }
      }
    }

    if (validationErrors.length !== 0) {
      logger.info({
        message: "found validation errors",
        count: validationErrors.length,
      });

      await args.appUtils.leaveCommentOnPr(
        args.pr,
        await renderMustacheFromFile(
          relativeDir("messages", "validation-errors.md"),
          {
            validationErrors: validationErrors,
          },
        ),
      );
    }
  }
}

async function listPR(args: OSSDirectoryPullRequestArgs) {
  const pr = await OSSDirectoryPullRequest.init(args);
  await pr.list();
}

async function validatePR(args: OSSDirectoryPullRequestArgs) {
  const pr = await OSSDirectoryPullRequest.init(args);
  await pr.validate();
}