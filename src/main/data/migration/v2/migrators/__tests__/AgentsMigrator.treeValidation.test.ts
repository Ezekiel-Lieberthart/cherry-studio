import { setupTestDatabase } from '@test-helpers/db'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSessionMessageTable } from '@data/db/schemas/agentSessionMessage'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { AgentSessionMessageTreeSeeder } from '@data/db/seeding/seeders/AgentSessionMessageTreeSeeder'
import { SeedRunner } from '@data/db/seeding/SeedRunner'
import { agentSessionMessageService as service } from '@data/services/AgentSessionMessageService'
import { readAgentSessionPath } from '@data/services/agentSessionMessageTree'

import { importLegacySessionMessages } from '../AgentsMigrator'
import { createEmptyAgentsSchemaInfo } from '../mappings/AgentsDbMappings'
type LegacyMessageRow = {
  id: number
  sessionId: string
  role: string
  content: unknown
  agentSessionId?: string | null
  createdAt?: string
  updatedAt?: string
}

describe('Session tree migration validation', () => {
  const dbh = setupTestDatabase()
  const insertedSessions: string[] = []

  beforeEach(async () => {
    await dbh.db.delete(agentSessionMessageTable)
    // agent_session_message FK-cascades from agent_session; cleaning the
    // sessions inserted by previous cases keeps each test isolated without
    // needing to manage transactions.
    for (const sid of insertedSessions) {
      await dbh.db.delete(agentSessionTable).where(eq(agentSessionTable.id, sid))
    }
    insertedSessions.length = 0
    await dbh.db.delete(agentTable)
    await dbh.db.insert(agentTable).values({
      id: 'a1',
      type: 'claude_code',
      name: 'a1',
      instructions: '',
      model: null,
      orderKey: 'a0'
    })
  })

  async function seedSession(id: string): Promise<void> {
    const workspaceId = `workspace-${id}`
    await dbh.db.insert(agentWorkspaceTable).values({
      id: workspaceId,
      name: workspaceId,
      path: `/tmp/${workspaceId}`,
      type: 'user',
      orderKey: 'a0'
    })
    await dbh.db.insert(agentSessionTable).values({
      id,
      agentId: 'a1',
      name: id,
      workspaceId,
      orderKey: 'a0'
    })
    insertedSessions.push(id)
  }

  async function importLegacyRows(rows: LegacyMessageRow[], options: { includeId?: boolean } = {}): Promise<number> {
    const includeId = options.includeId ?? true
    dbh.db.run(sql.raw("ATTACH DATABASE ':memory:' AS agents_legacy"))
    try {
      dbh.db.run(
        sql.raw(`CREATE TABLE agents_legacy.session_messages (
          ${includeId ? 'id INTEGER PRIMARY KEY,' : ''}
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          agent_session_id TEXT,
          created_at TEXT,
          updated_at TEXT
        )`)
      )
      dbh.db.run(sql.raw('CREATE TABLE agents_legacy.agents (id TEXT PRIMARY KEY)'))
      dbh.db.run(
        sql.raw(
          'CREATE TABLE agents_legacy.sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id))'
        )
      )
      dbh.db.run(sql.raw("INSERT INTO agents_legacy.agents (id) VALUES ('a1')"))

      const idColumn = includeId ? sql.raw('id,') : sql.raw('')
      for (const row of rows) {
        dbh.db.run(sql`
          INSERT OR IGNORE INTO agents_legacy.sessions (id, agent_id)
          VALUES (${row.sessionId}, 'a1')
        `)
        const idValue = includeId ? sql`${row.id},` : sql.raw('')
        dbh.db.run(sql`
          INSERT INTO agents_legacy.session_messages
            (${idColumn} session_id, role, content, agent_session_id, created_at, updated_at)
          VALUES
            (
              ${idValue}
              ${row.sessionId},
              ${row.role},
              ${JSON.stringify(row.content)},
              ${row.agentSessionId ?? null},
              ${row.createdAt ?? '2026-01-01T00:00:00.000Z'},
              ${row.updatedAt ?? '2026-01-01T00:00:01.000Z'}
            )
        `)
      }

      const schemaInfo = createEmptyAgentsSchemaInfo()
      schemaInfo.agents = {
        exists: true,
        columns: new Set(['id'])
      }
      schemaInfo.sessions = {
        exists: true,
        columns: new Set(['id', 'agent_id'])
      }
      schemaInfo.session_messages = {
        exists: true,
        columns: new Set([
          ...(includeId ? ['id'] : []),
          'session_id',
          'role',
          'content',
          'agent_session_id',
          'created_at',
          'updated_at'
        ])
      }

      return await importLegacySessionMessages(dbh.db, schemaInfo)
    } finally {
      dbh.db.run(sql.raw('DETACH DATABASE agents_legacy'))
    }
  }

  it('preserves 10001 legacy messages through import, startup seeding and every cursor page', async () => {
    const sessionId = 'migrated-history'
    await seedSession(sessionId)
    const count = 10001
    const sourceRows = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      sessionId,
      role: index % 2 ? 'assistant' : 'user',
      content: { parts: [{ type: 'text', text: `source-${index}` }] },
      agentSessionId: 'native-legacy',
      createdAt: new Date(1700000000000 + Math.floor(index / 4)).toISOString(),
      updatedAt: new Date(1700000010000 + Math.floor(index / 4)).toISOString()
    }))
    expect(await importLegacyRows(sourceRows)).toBe(count)
    const before = dbh.db.select().from(agentSessionMessageTable).all()
    const runner = new SeedRunner(dbh.db)
    runner.runAll([new AgentSessionMessageTreeSeeder()])
    const path = readAgentSessionPath(dbh.db, sessionId)
    expect(path.map((row) => row.data.parts)).toEqual(sourceRows.map((row) => row.content.parts))
    expect(service.branchTip(sessionId, path[0].id)).toBe(path.at(-1)!.id)
    const originals = new Map(before.map((row) => [row.id, row]))
    for (const row of path) expect(row).toEqual({ ...originals.get(row.id), parentId: expect.any(String) })
    const visible: string[] = []
    let cursor: string | undefined
    do {
      const page = service.listSessionMessages(sessionId, { limit: 200, cursor })
      visible.push(...page.items.map((row) => row.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(visible).toEqual(path.map((row) => row.id).reverse())
    expect(new Set(visible).size).toBe(count)
    runner.runAll([new AgentSessionMessageTreeSeeder()])
    expect(readAgentSessionPath(dbh.db, sessionId)).toEqual(path)
    expect(dbh.sqlite.pragma('foreign_key_check')).toEqual([])
  }, 120000)

  it('builds each imported tree in normalized timestamp order without changing Session timestamps', async () => {
    await seedSession('timezones')
    await seedSession('interleaved')
    const sessionsBefore = dbh.db.select().from(agentSessionTable).all()
    await importLegacyRows([
      {
        id: 1,
        sessionId: 'timezones',
        role: 'user',
        content: { parts: [{ type: 'text', text: 'later' }] },
        createdAt: '2026-01-01T00:00:00Z'
      },
      {
        id: 2,
        sessionId: 'interleaved',
        role: 'user',
        content: { parts: [{ type: 'text', text: 'other' }] },
        createdAt: '2026-01-01T00:30:00Z'
      },
      {
        id: 3,
        sessionId: 'timezones',
        role: 'assistant',
        content: { parts: [{ type: 'text', text: 'earlier' }] },
        createdAt: '2026-01-01T01:00:00+02:00'
      }
    ])
    expect(readAgentSessionPath(dbh.db, 'timezones').map((row) => row.data.parts)).toEqual([
      [{ type: 'text', text: 'earlier' }],
      [{ type: 'text', text: 'later' }]
    ])
    expect(readAgentSessionPath(dbh.db, 'interleaved')).toHaveLength(1)
    for (const session of sessionsBefore) {
      expect(dbh.db.select().from(agentSessionTable).where(eq(agentSessionTable.id, session.id)).get()).toEqual({
        ...session,
        activeNodeId: expect.any(String)
      })
    }
    expect(dbh.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  async function archive() {
    const sessionId = 'operation-history'
    await seedSession(sessionId)
    await importLegacyRows(
      Array.from({ length: 3 }, (_, i) => ({
        id: i + 1,
        sessionId,
        role: i % 2 ? 'assistant' : 'user',
        content: { parts: [{ type: 'text', text: `source-${i}` }] },
        agentSessionId: 'native-legacy'
      }))
    )
    new AgentSessionMessageTreeSeeder().run(dbh.db)
    return { sessionId, rows: readAgentSessionPath(dbh.db, sessionId) }
  }

  it('rejects root mutation and cross-session selection without changing history', async () => {
    const { sessionId, rows } = await archive()
    const rootId = rows[0].parentId!
    expect(() => service.deleteSessionMessage(sessionId, rootId)).toThrow()
    expect(() => service.updateSessionMessage(sessionId, rootId, { data: { parts: [] } })).toThrow()
    await seedSession('other-session')
    const other = service.captureHead('other-session')
    expect(() => service.selectBranch(sessionId, other)).toThrow()
    expect(() =>
      service.saveMessage({ sessionId, parentId: other, message: { role: 'user', data: { parts: [] } } })
    ).toThrow()
    expect(readAgentSessionPath(dbh.db, sessionId)).toEqual(rows)
  })

  it('rejects direct edits and deletion after an input has a native identity', async () => {
    const { sessionId, rows } = await archive()
    dbh.db
      .update(agentSessionMessageTable)
      .set({ data: { ...rows[0].data, nativeSessionId: 'native' } })
      .where(eq(agentSessionMessageTable.id, rows[0].id))
      .run()
    const before = readAgentSessionPath(dbh.db, sessionId)
    expect(() => service.updateSessionMessage(sessionId, rows[0].id, { data: { parts: [] } })).toThrow()
    expect(() => service.deleteSessionMessage(sessionId, rows[0].id)).toThrow()
    expect(readAgentSessionPath(dbh.db, sessionId)).toEqual(before)
  })

  it.each(['accepted', 'delivering'] as const)(
    'rejects patching a %s delivery before native input binding',
    async (state) => {
      await seedSession('sender')
      await seedSession('receiver')
      const request = service.acceptSessionDelivery({
        senderAgentId: 'a1',
        senderSessionId: 'sender',
        receiverSessionId: 'receiver',
        content: 'original instruction'
      })
      if (state === 'delivering')
        service.transitionSessionDelivery('receiver', request.id, 'delivering', {
          expected: ['accepted'],
          turnRef: 'running-reply'
        })
      const before = service.getSessionMessage('receiver', request.id)
      expect(() => service.deleteSessionMessage('receiver', request.id)).toThrow()
      expect(() =>
        service.updateSessionMessage('receiver', request.id, {
          data: { parts: [{ type: 'text', text: 'changed instruction' }] }
        })
      ).toThrow(expect.objectContaining({ code: 'RESOURCE_LOCKED' }))
      expect(service.getSessionMessage('receiver', request.id)).toEqual(before)
    }
  )

  it('rejects editing outside the selected branch or while another response is pending', async () => {
    const { sessionId, rows } = await archive()
    const alternative = service.saveMessage({
      sessionId,
      parentId: rows[0].parentId!,
      message: { role: 'user', status: 'success', data: { parts: [{ type: 'text', text: 'alternative' }] } }
    })
    service.selectBranch(sessionId, alternative.id)
    expect(() => service.readEditSnapshotTx(dbh.db, sessionId, rows[0].id)).toThrow()
    service.saveMessage({ sessionId, message: { role: 'assistant', status: 'pending', data: { parts: [] } } })
    expect(() => service.readEditSnapshotTx(dbh.db, sessionId, alternative.id)).toThrow()
  })
})
