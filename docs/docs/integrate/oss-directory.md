---
title: oss-directory
sidebar_position: 4
---

[OSS Directory](https://github.com/opensource-observer/oss-directory) contains structured data on as many open source projects as possible, enumerating all artifacts related to the project, from source code repositories to published packages and deployments.

## NPM Library

OSS Directory is a library that you can use in your own projects. This may be useful if you want to build a tool that uses the data in this repository or perform your own custom analysis.

### Installation

Install the library

```bash
npm install --save oss-directory
# OR yarn add oss-directory
# OR pnpm add oss-directory
```

### Fetch all of the data

You can fetch all of the data in this repo with the following:

```js
import { Project, Collection, fetchData } from "oss-directory";

const data = await fetchData();
const projects: Project[] = data.projects;
const collections: Collection[] = data.collections;
```

:::note
We don't store the entire dataset with the npm package. Under the hood, this will clone the repository into a temporary directory, read all the data files, validate the schema, and return the objects. This way, you know you're getting the latest data, even if the npm package hasn't been updated in a while.
:::

## Python library

Coming soon...

To track progress, see the [issue on GitHub](https://github.com/opensource-observer/oss-directory/issues/18).

## Download the data from GitHub

All of the data is accessible from directly GitHub. You can clone the repository and use the data in your own projects.

[https://github.com/opensource-observer/oss-directory](https://github.com/opensource-observer/oss-directory)

### Directory layout

The OSS Directory is organized into two main folders:

- `./data/projects` - each file represents a single open source project and contains all of the artifacts for that project.
  - See `./src/resources/schema/project.json` for the expected JSON schema
  - Files should be named by the project "slug"
  - Project slugs must be globally unique. If there is a conflict in chosen slug, we will give priority to the project that has the associated GitHub organization
  - In most cases, we adopt the GitHub organization name as the slug. If the project is not associated with a GitHub organization, you try to use the project name followed by the repo owner as the slug.
- `./data/collections` - each file represents a collection of projects that have some collective meaning (e.g. all projects in an ecosystem).
  - See `./src/resources/schema/collection.json` for the expected JSON schema
  - Collections are identified by their unique slug