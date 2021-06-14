import { Octokit } from '@octokit/rest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import mysql from 'promise-mysql'
import * as _ from 'lodash'
import markdownTable from 'markdown-table'
import { scheduleJob } from 'node-schedule'

type TGithubAuthentication = {
    token: string;
    repo: string;
    owner: string;
}

type TGithubIssue = {
    title?: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
}

type TDatabaseAuthentication = {
    host: string;
    user: string;
    password: string;
    database: string;
    tables?: string[];
}

class Integrity {
    private octokit: Octokit;
    private connection: mysql.Connection;
    private running: boolean;
    private scheduled: boolean;

    private dumpFilename: string;
    private dumpPath = resolve(process.cwd(), 'dumps');

    constructor (private databaseAuthentication: TDatabaseAuthentication, private githubAuthentication: TGithubAuthentication, private issue?: TGithubIssue) {
      if (!this.githubAuthentication?.token) {
        throw new Error('Please provide a Github Token')
      }

      if (
        !this.databaseAuthentication?.host ||
        !this.databaseAuthentication?.user ||
        !this.databaseAuthentication?.password ||
        !this.databaseAuthentication?.database) {
        throw new Error('Please provide a valid database connection details')
      }

      if (!existsSync(this.dumpPath)) {
        mkdirSync(this.dumpPath)
      }

      this.octokit = new Octokit({
        auth: this.githubAuthentication.token
      })

      this.dumpFilename = resolve(this.dumpPath, `${this.databaseAuthentication.database}.dump`)
    }

    async run (): Promise<void> {
      const oldData = await this.getDumpData()
      const newData = await this.getTables()

      await this.saveDumpData(newData)

      if (!oldData) {
        console.log(`No past data for schema ${this.databaseAuthentication.database}`)
        return
      }

      const comparedData = await this.compareTables(this.groupByTableName(newData), this.groupByTableName(oldData))

      if (!comparedData.length) {
        console.log('Nothing changed')
        return
      }

      const mdTables = []
      const columnByTableName = this.groupByTableName(comparedData)

      /* generate markdown tables */
      for (const table of Object.keys(columnByTableName)) {
        const mdTable = markdownTable(
          [
            Object.keys(columnByTableName[table][0]).splice(1),
            ...columnByTableName[table].map(column => Object.values(column).splice(1))
          ],
          { align: ['c', 'c', 'c'] }
        )

        mdTables.push({
          table_name: table,
          table_data: mdTable
        })
      }

      await this.generateGithubIssue(mdTables)
    }

    async schedule (expression = '0 */1 * * *'): Promise<void> {
      scheduleJob(expression, async () => await this.run())
    }

    private async generateGithubIssue (tables) {
      const issueTitle = `warning: Alterações no banco de dados \`${this.databaseAuthentication.database}\``
      const issueBody = []

      issueBody.push(`O banco de dados \`${this.databaseAuthentication.database}\` teve uma ou mais de suas tabelas alteradas, e precisam de atenção!\n`)
      tables.forEach(table => {
        issueBody.push(`## ${table.table_name} \n ${table.table_data} \n`)
      })

      const issue = await this.octokit.issues.create({
        owner: this.githubAuthentication.owner,
        repo: this.githubAuthentication.repo,
        title: issueTitle,
        body: issueBody.join('\n')
      })

      if (this.issue.labels.length) {
        await this.octokit.issues.addLabels({
          issue_number: issue.data.number,
          labels: this.issue.labels,
          owner: this.githubAuthentication.owner,
          repo: this.githubAuthentication.repo
        })
      }

      if (this.issue.assignees.length) {
        await this.octokit.issues.addAssignees({
          issue_number: issue.data.number,
          assignees: this.issue.assignees,
          owner: this.githubAuthentication.owner,
          repo: this.githubAuthentication.repo
        })
      }
    }

    private async compareTables (newTables, oldtables) {
      const tables = Object.keys(newTables)

      const changes = []

      for (const tableName of tables) {
        const newTable = newTables[tableName]
        const oldtable = oldtables[tableName]

        /* Check if any column was added or removed */
        const fields = _.uniq(_.map([...newTable, ...oldtable], 'COLUMN_NAME'))

        for (const field of fields) {
          const fieldInNew = newTable.find(f => f.COLUMN_NAME === field)
          const fieldInOld = oldtable.find(f => f.COLUMN_NAME === field)

          /* Column in both */
          if (fieldInNew && fieldInOld) {
            for (const prop of ['COLUMN_NAME', 'IS_NULLABLE', 'COLUMN_TYPE']) {
              /* Check if value changed */
              if (fieldInNew[prop] !== fieldInOld[prop]) {
                changes.push({
                  ...fieldInNew,
                  [prop]: `~~${fieldInOld[prop]}~~<br/>**${fieldInNew[prop]}**`,
                  ACTION: 'changed'
                })
              }
            }
          } else {
            /* Added or dropped */
            if (fieldInNew) {
              /* Added */
              console.log('added', field)
              changes.push({
                TABLE_NAME: fieldInNew.TABLE_NAME,
                COLUMN_NAME: `\`${fieldInNew.COLUMN_NAME}\``,
                IS_NULLABLE: `\`${fieldInNew.IS_NULLABLE}\``,
                COLUMN_TYPE: `\`${fieldInNew.COLUMN_TYPE}\``,
                ACTION: 'added'
              })
            } else {
              /* Dropped */
              console.log('dropped', field)
              changes.push({
                TABLE_NAME: fieldInOld.TABLE_NAME,
                COLUMN_NAME: `~~${fieldInOld.COLUMN_NAME}~~`,
                IS_NULLABLE: `~~${fieldInOld.IS_NULLABLE}~~`,
                COLUMN_TYPE: `~~${fieldInOld.COLUMN_TYPE}~~`,
                ACTION: 'dropped'
              })
            }
          }
        }
      }

      return changes
    }

    private async saveDumpData (data) {
      await writeFileSync(this.dumpFilename, JSON.stringify(data))
    }

    private async getDumpData () {
      if (!existsSync(this.dumpFilename)) return false

      const data = await readFileSync(this.dumpFilename, { encoding: 'utf8' })

      return JSON.parse(data)
    }

    private async createConnection () {
      this.connection = await mysql.createConnection({
        host: this.databaseAuthentication.host,
        user: this.databaseAuthentication.user,
        password: this.databaseAuthentication.password,
        database: this.databaseAuthentication.database
      })
    }

    private async getTables () {
      if (!this.connection) await this.createConnection()

      const tables = await this.connection.query(`SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.columns WHERE table_schema = '${this.databaseAuthentication.database}'`)

      return tables.map(t => Object.assign({}, t))
    }

    private groupByTableName (columns) {
      return columns.reduce(function (r, a) {
        r[a.TABLE_NAME] = r[a.TABLE_NAME] || []
        r[a.TABLE_NAME].push(a)
        return r
      }, Object.create(null))
    }
}

export default Integrity
