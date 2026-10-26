// @ts-check
// Every place the server keeps files, in one module. Today all of it is on the local disk exactly where it always was; a hosted
// deployment changes these roots (env), not the code that uses them (CLONER_SPEC.md Phase 6: persistent disk, object storage).
//
//   DATA_DIR        SAS_DATA_DIR, else <repo>/data             the database and every project's files
//   DB_FILE         <DATA_DIR>/app.db
//   PROJECTS_DIR    <DATA_DIR>/projects                        projectDir(id) = <PROJECTS_DIR>/<id>
//   auditDir        <projectDir>/audit[/<analysisId>]          an analysis's files (crawl, axe, Lighthouse, screens/)
//   recreateRoot    <projectDir>/recreate                      every copy of the project (<recreateId>/…)
//   BACKUPS_DIR     <DATA_DIR>/backups                         dated database backups (db/backup.js)
//   LOGS_DIR        <DATA_DIR>                                 the admin's copy-issues.log (copy/serverLog.js)
//   tempDir()       SAS_TEMP_DIR, else the OS temp folder      throwaway folders of a job (read at call time: tests set it)
//   TOOLCHAINS_DIR  <server>/toolchains                        the stacks' pinned build tools (not data: part of the install)
// There is no downloads folder: a zip or a PDF is streamed from the copy's own folder and never stored.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server package folder (where package.json is). */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DATA_DIR = process.env.SAS_DATA_DIR ? path.resolve(process.env.SAS_DATA_DIR) : path.resolve(SERVER_DIR, '..', 'data');
export const DB_FILE = path.join(DATA_DIR, 'app.db');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const LOGS_DIR = DATA_DIR;
export const TOOLCHAINS_DIR = path.join(SERVER_DIR, 'toolchains');

/** @param {string} projectId */
export const projectDir = (projectId) => path.join(PROJECTS_DIR, projectId);

/**
 * @param {string} projectId
 * @param {string} [analysisId]  omitted: the folder that holds every analysis of the project
 */
export const auditDir = (projectId, analysisId) => (analysisId ? path.join(projectDir(projectId), 'audit', analysisId) : path.join(projectDir(projectId), 'audit'));

/** @param {string} projectId */
export const recreateRoot = (projectId) => path.join(projectDir(projectId), 'recreate');

/** @param {string} id  a stack toolchain (react-vite, next, mern) */
export const toolchainDir = (id) => path.join(TOOLCHAINS_DIR, id);

/** The folder throwaway job folders go into. */
export const tempDir = () => process.env.SAS_TEMP_DIR || os.tmpdir();
