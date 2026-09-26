import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { PostalRoute, RouteNode } from '@/types/route'
import { daysBetween, isValidDate } from '@/utils/dateRange'
import { nextSerialNo, nowIso, uid } from '@/utils/id'

/** 由节点日期计算全程天数：取首个与末个有效日期的间隔。 */
export function computeTotalDays(nodes: RouteNode[]): number {
  const dated = nodes.filter((n) => isValidDate(n.arriveDate))
  if (dated.length < 2) return 0
  const span = daysBetween(dated[0].arriveDate, dated[dated.length - 1].arriveDate)
  return span == null || span < 0 ? 0 : span
}

/** 新建节点。 */
export function createRouteNode(office = '', arriveDate = '', transitMark = ''): RouteNode {
  return { key: uid('node'), office, arriveDate, transitMark }
}

/** 作废方案中的一条：挂在邮路下的一封实寄封的去向。 */
export interface VoidPlanItem {
  coverId: number
  /** 转挂目标邮路 id；null 表示留作未关联 */
  targetRouteId: number | null
}

export const useRouteStore = defineStore('route', () => {
  const list = ref<PostalRoute[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.routes.orderBy('routeNo').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  function nextRouteNo(): string {
    return nextSerialNo('RT-', list.value.map((r) => r.routeNo))
  }

  async function create(input: PostalRoute): Promise<number> {
    const now = nowIso()
    const record: PostalRoute = {
      ...input,
      routeNo: input.routeNo || nextRouteNo(),
      nodes: input.nodes.map((n) => ({ ...n, key: n.key || uid('node') })),
      totalDays: computeTotalDays(input.nodes),
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const id = await db.routes.add(record)
    await load()
    return id
  }

  async function update(id: number, patch: Partial<PostalRoute>): Promise<void> {
    const next: Partial<PostalRoute> = { ...patch, updatedAt: nowIso() }
    if (patch.nodes) next.totalDays = computeTotalDays(patch.nodes)
    await db.routes.update(id, next)
    await load()
  }

  async function remove(id: number): Promise<void> {
    await db.routes.delete(id)
    await load()
  }

  /**
   * 作废并撤下邮路：按逐封方案把关联实寄封转挂到其他邮路或留作未关联，
   * 随后删除邮路。全部写操作放在同一事务里——任一封没处理好，
   * 邮路与其余封都保持不变。
   */
  async function voidRoute(id: number, plan: VoidPlanItem[]): Promise<void> {
    const now = nowIso()
    try {
      await db.transaction('rw', db.routes, db.covers, async () => {
        const route = await db.routes.get(id)
        if (!route) throw new Error('该邮路不存在或已被撤下')
        const attached = await db.covers.where('routeId').equals(id).toArray()
        const planMap = new Map(plan.map((p) => [p.coverId, p.targetRouteId]))
        const uncovered = attached.find((c) => typeof c.id !== 'number' || !planMap.has(c.id))
        if (uncovered) throw new Error(`实寄封 ${uncovered.coverNo} 尚未指定去向`)
        for (const item of plan) {
          const cover = await db.covers.get(item.coverId)
          if (!cover || cover.routeId !== id) {
            throw new Error('有实寄封已不在该邮路下，请刷新后重试')
          }
          if (item.targetRouteId != null) {
            if (item.targetRouteId === id) throw new Error('不能转挂到即将撤下的邮路')
            const target = await db.routes.get(item.targetRouteId)
            if (!target) throw new Error(`目标邮路 #${item.targetRouteId} 不存在`)
          }
        }
        for (const item of plan) {
          await db.covers.update(item.coverId, { routeId: item.targetRouteId, updatedAt: now })
        }
        await db.routes.delete(id)
      })
    } finally {
      await load()
    }
  }

  /** 节点拖拽排序 */
  async function moveNode(id: number, from: number, to: number): Promise<void> {
    const route = byId(id)
    if (!route) return
    const nodes = route.nodes.map((n) => ({ ...n }))
    if (from < 0 || from >= nodes.length || to < 0 || to >= nodes.length || from === to) return
    const [moved] = nodes.splice(from, 1)
    nodes.splice(to, 0, moved)
    await update(id, { nodes })
  }

  /** 新增中转节点，可指定插入位置 */
  async function addNode(id: number, node: RouteNode, index?: number): Promise<void> {
    const route = byId(id)
    if (!route) return
    const nodes = route.nodes.map((n) => ({ ...n }))
    nodes.splice(index == null ? nodes.length : index, 0, { ...node })
    await update(id, { nodes })
  }

  async function removeNode(id: number, key: string): Promise<void> {
    const route = byId(id)
    if (!route) return
    await update(id, { nodes: route.nodes.filter((n) => n.key !== key) })
  }

  function byId(id: number | null | undefined): PostalRoute | null {
    if (id == null) return null
    return list.value.find((r) => r.id === id) ?? null
  }

  /** 缺少日期的节点数，供缺日警示使用 */
  function missingDateCount(route: PostalRoute | null): number {
    if (!route) return 0
    return route.nodes.filter((n) => !isValidDate(n.arriveDate)).length
  }

  const total = computed(() => list.value.length)

  return {
    list,
    loading,
    loaded,
    total,
    load,
    nextRouteNo,
    create,
    update,
    remove,
    voidRoute,
    moveNode,
    addNode,
    removeNode,
    byId,
    missingDateCount
  }
})
