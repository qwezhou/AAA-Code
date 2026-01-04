<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import DOMPurify from 'dompurify'
import { VueMonacoEditor } from '@guolao/vue-monaco-editor'

type UserStatus = {
  id: number | null
  name: string | null
  is_signed_in: boolean
  is_premium: boolean
  is_verified: boolean | null
  session_id: number | null
}

type ProblemItem = {
  id: number
  frontendId: string
  title: string
  titleZh?: string | null
  titleSlug: string
  paidOnly: boolean
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Unknown'
  status: string | null
  acRate: number | null
}

type Question = {
  id: string
  frontend_id: string
  title: string
  translated_title?: string | null
  title_slug: string
  is_paid_only: boolean
  difficulty: string
  likes: number
  dislikes: number
  content: string
  translated_content?: string | null
  testcase_list: string[]
  topic_tags: { name: string; slug: string }[]
  code_snippets?: { lang: string; lang_slug: string; code: string }[]
}

type SubmissionCheck = {
  state?: string
  status_code?: number
  status_msg?: string
  run_success?: boolean
  runtime?: string
  memory?: string
  total_correct?: number
  total_testcases?: number
  last_testcase?: string
  expected_output?: string
  code_output?: string
  compare_result?: string
  submission_id?: number
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(text || `${resp.status} ${resp.statusText}`)
  }

  return resp.json() as Promise<T>
}

const domain = ref<'leetcode.com' | 'leetcode.cn'>('leetcode.com')
const cookie = ref('')
const authError = ref<string | null>(null)
const authWarning = ref<string | null>(null)

const user = ref<UserStatus | null>(null)
const loadingMe = ref(false)

const q = ref('')
const listLoading = ref(false)
const problems = ref<ProblemItem[]>([])
const listError = ref<string | null>(null)

const selectedSlug = ref<string | null>(null)
const questionLoading = ref(false)
const question = ref<Question | null>(null)
const questionError = ref<string | null>(null)

const langSlug = ref<string>('')
const typedCode = ref<string>('')
const submitLoading = ref(false)
const submitError = ref<string | null>(null)
const submissionId = ref<number | null>(null)
const submission = ref<SubmissionCheck | null>(null)
let pollTimer: number | null = null

function monacoLanguageFor(slug: string): string {
  const s = slug.toLowerCase()
  if (s === 'python3' || s === 'python') return 'python'
  if (s === 'golang') return 'go'
  if (s === 'cpp') return 'cpp'
  if (s === 'csharp') return 'csharp'
  if (s === 'javascript') return 'javascript'
  if (s === 'typescript') return 'typescript'
  if (s === 'java') return 'java'
  if (s === 'kotlin') return 'kotlin'
  if (s === 'rust') return 'rust'
  if (s === 'php') return 'php'
  if (s === 'ruby') return 'ruby'
  if (s === 'swift') return 'swift'
  return 'plaintext'
}

const codeLanguage = computed(() => monacoLanguageFor(langSlug.value))
const availableSnippets = computed(() => question.value?.code_snippets || [])

function resetSubmissionState() {
  submitError.value = null
  submissionId.value = null
  submission.value = null
  if (pollTimer != null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

const isAuthed = computed(() => Boolean(user.value?.is_signed_in))

async function refreshMe() {
  loadingMe.value = true
  try {
    const data = await api<{ user: UserStatus }>('/api/auth/me', { method: 'GET' })
    user.value = data.user
  } catch {
    user.value = null
  } finally {
    loadingMe.value = false
  }
}

async function signInByCookie() {
  authError.value = null
  authWarning.value = null
  try {
    const data = await api<{ user: UserStatus; emailNotVerified?: boolean }>('/api/auth/cookie', {
      method: 'POST',
      body: JSON.stringify({ cookie: cookie.value, domain: domain.value }),
    })
    user.value = data.user
    if (data.emailNotVerified) {
      authWarning.value = '你的 LeetCode 账号邮箱未验证：已允许登录，但部分能力可能受限（建议去 LeetCode 完成邮箱验证）。'
    }
    cookie.value = ''
    await loadProblems()
  } catch (e) {
    authError.value = e instanceof Error ? e.message : String(e)
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' })
  user.value = null
  authWarning.value = null
  problems.value = []
  selectedSlug.value = null
  question.value = null
}

async function loadProblems() {
  if (!isAuthed.value) return

  listError.value = null
  listLoading.value = true
  try {
    const params = new URLSearchParams()
    params.set('lang', 'zh')
    if (q.value.trim()) params.set('q', q.value.trim())
    const data = await api<{ items: ProblemItem[] }>(`/api/problems?${params.toString()}`, {
      method: 'GET',
    })
    problems.value = data.items
  } catch (e) {
    listError.value = e instanceof Error ? e.message : String(e)
  } finally {
    listLoading.value = false
  }
}

async function openProblem(slug: string) {
  selectedSlug.value = slug
  question.value = null
  questionError.value = null
  questionLoading.value = true
  resetSubmissionState()
  try {
    const data = await api<{ question: Question }>(`/api/problem/${encodeURIComponent(slug)}`, {
      method: 'GET',
    })
    question.value = data.question

    const snippets = data.question.code_snippets || []
    const preferred =
      snippets.find((s) => s.lang_slug === 'typescript') ||
      snippets.find((s) => s.lang_slug === 'javascript') ||
      snippets.find((s) => s.lang_slug === 'python3') ||
      snippets[0]
    langSlug.value = preferred?.lang_slug || ''
    typedCode.value = preferred?.code || ''
  } catch (e) {
    questionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    questionLoading.value = false
  }
}

function backToList() {
  selectedSlug.value = null
  question.value = null
  questionError.value = null
  langSlug.value = ''
  typedCode.value = ''
  resetSubmissionState()
}

function selectLang(next: string) {
  langSlug.value = next
  const snippet = availableSnippets.value.find((s) => s.lang_slug === next)
  typedCode.value = snippet?.code || ''
  resetSubmissionState()
}

async function pollSubmission() {
  if (!submissionId.value || !selectedSlug.value) return
  try {
    const data = await api<{ submission: SubmissionCheck }>(
      `/api/submission/${submissionId.value}/check?slug=${encodeURIComponent(selectedSlug.value)}`,
      { method: 'GET' }
    )
    submission.value = data.submission
    const state = String(data.submission?.state || '').toUpperCase()
    if (state === 'SUCCESS') {
      if (pollTimer != null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
    }
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e)
    if (pollTimer != null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

async function submitSolution() {
  if (!selectedSlug.value || !question.value) return
  if (!langSlug.value) {
    submitError.value = '请选择语言'
    return
  }
  if (!typedCode.value.trim()) {
    submitError.value = '代码不能为空'
    return
  }

  submitLoading.value = true
  submitError.value = null
  submission.value = null
  submissionId.value = null

  try {
    const data = await api<{ submissionId: number }>('/api/submit', {
      method: 'POST',
      body: JSON.stringify({
        slug: selectedSlug.value,
        lang: langSlug.value,
        code: typedCode.value,
        questionId: question.value.id,
      }),
    })
    submissionId.value = data.submissionId
    await pollSubmission()
    if (pollTimer == null) {
      pollTimer = window.setInterval(pollSubmission, 1000)
    }
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitLoading.value = false
  }
}

const sanitizedContent = computed(() => {
  const q = question.value
  if (!q) return ''

  const html = (q.translated_content || q.content || '').trim()
  if (!html) return ''
  return DOMPurify.sanitize(html)
})

onMounted(async () => {
  await refreshMe()
  if (isAuthed.value) await loadProblems()
})
</script>

<template>
  <div class="min-h-full">
    <header class="border-b border-zinc-800 bg-zinc-950/60">
      <div class="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <div class="flex items-center gap-2">
          <Icon icon="mdi:code-tags" class="text-zinc-200" width="20" />
          <div class="font-semibold">LeetLite</div>
          <div class="text-xs text-zinc-400">第三方刷题（最小可用）</div>
        </div>

        <div class="flex items-center gap-2 text-sm">
          <div v-if="loadingMe" class="text-zinc-400">同步登录状态...</div>
          <template v-else-if="isAuthed">
            <div class="text-zinc-300">
              已登录：<span class="font-medium">{{ user?.name }}</span>
            </div>
            <button
              class="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-200 hover:bg-zinc-900"
              @click="logout">
              <Icon icon="mdi:logout" width="18" />
              退出
            </button>
          </template>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-7xl px-4 py-6">
      <!-- Login -->
      <section v-if="!isAuthed" class="mx-auto max-w-2xl">
        <div class="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <div class="mb-3 flex items-center gap-2">
            <Icon icon="mdi:cookie" width="18" class="text-zinc-200" />
            <h1 class="text-lg font-semibold">使用 Cookie 登录</h1>
          </div>

          <div class="text-sm text-zinc-400">
            从浏览器开发者工具 Network 中，复制任意 leetcode 请求的 <span class="text-zinc-200">Request Headers</span>
            里的 Cookie（不是 Response Headers 的 Set-Cookie）。需要包含 <span class="text-zinc-200">csrftoken</span>
            和 <span class="text-zinc-200">LEETCODE_SESSION</span>。
          </div>

          <div class="mt-4 grid gap-3">
            <label class="text-sm text-zinc-300">
              站点
              <select v-model="domain"
                class="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200">
                <option value="leetcode.com">leetcode.com</option>
                <option value="leetcode.cn">leetcode.cn</option>
              </select>
            </label>

            <label class="text-sm text-zinc-300">
              Cookie
              <textarea v-model="cookie" rows="5"
                class="mt-1 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200"
                placeholder="csrftoken=...; LEETCODE_SESSION=...; ..." />
            </label>

            <div v-if="authError" class="rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200">
              {{ authError }}
            </div>

            <div v-if="authWarning"
              class="rounded-md border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-200">
              {{ authWarning }}
            </div>

            <button
              class="inline-flex items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
              @click="signInByCookie">
              <Icon icon="mdi:login" width="18" />
              登录
            </button>
          </div>
        </div>
      </section>

      <!-- Problems list -->
      <section v-else-if="!selectedSlug" class="grid gap-4">
        <div
          class="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-2">
            <Icon icon="mdi:format-list-bulleted" width="18" class="text-zinc-200" />
            <h2 class="text-lg font-semibold">题库</h2>
            <div class="text-sm text-zinc-400">{{ problems.length }} 道</div>
          </div>

          <div class="flex gap-2">
            <input v-model="q"
              class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 sm:w-80"
              placeholder="搜索（题号/标题/slug）" @keydown.enter="loadProblems" />
            <button
              class="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
              @click="loadProblems">
              <Icon icon="mdi:magnify" width="18" />
              搜索
            </button>
          </div>
        </div>

        <div v-if="listError" class="rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200">
          {{ listError }}
        </div>

        <div v-if="listLoading" class="text-sm text-zinc-400">加载中...</div>

        <div v-else class="overflow-hidden rounded-lg border border-zinc-800">
          <div class="divide-y divide-zinc-800">
            <button v-for="p in problems" :key="p.id"
              class="flex w-full items-center justify-between gap-4 bg-zinc-950 px-4 py-3 text-left hover:bg-zinc-900"
              @click="openProblem(p.titleSlug)">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="w-12 shrink-0 text-sm text-zinc-400">{{ p.frontendId }}</span>
                  <span class="truncate text-sm font-medium text-zinc-100">{{ p.titleZh || p.title }}</span>
                  <Icon v-if="p.paidOnly" icon="mdi:star" width="16" class="text-amber-300" />
                </div>
                <div class="mt-1 text-xs text-zinc-500">{{ p.titleSlug }}</div>
              </div>

              <div class="flex shrink-0 items-center gap-2">
                <span class="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300" :class="{
                  'border-emerald-900/60 text-emerald-200': p.difficulty === 'Easy',
                  'border-amber-900/60 text-amber-200': p.difficulty === 'Medium',
                  'border-rose-900/60 text-rose-200': p.difficulty === 'Hard',
                }">
                  {{ p.difficulty }}
                </span>
                <span v-if="p.acRate != null" class="text-xs text-zinc-500">{{ p.acRate.toFixed(1) }}%</span>
                <Icon icon="mdi:chevron-right" width="18" class="text-zinc-500" />
              </div>
            </button>
          </div>
        </div>
      </section>

      <!-- Problem detail -->
      <section v-else class="grid gap-4">
        <div class="flex items-center justify-between">
          <button
            class="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
            @click="backToList">
            <Icon icon="mdi:chevron-left" width="18" />
            返回
          </button>

          <a class="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
            :href="`https://${domain}/problems/${selectedSlug}/`" target="_blank" rel="noreferrer">
            <Icon icon="mdi:open-in-new" width="18" />
            在 LeetCode 打开
          </a>
        </div>

        <div v-if="questionLoading" class="text-sm text-zinc-400">加载题目详情...</div>
        <div v-else-if="questionError"
          class="rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200">
          {{ questionError }}
        </div>

        <div v-else-if="question" class="grid gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <!-- Left: statement -->
          <article class="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <div class="mb-2 flex items-center gap-2">
              <Icon icon="mdi:file-document-outline" width="18" class="text-zinc-200" />
              <h1 class="text-lg font-semibold">
                {{ question.frontend_id }}. {{ question.translated_title || question.title }}
              </h1>
              <span class="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300">
                {{ question.difficulty }}
              </span>
            </div>

            <div class="lc-content text-sm leading-6 text-zinc-200" v-html="sanitizedContent" />
          </article>

          <!-- Right: editor -->
          <aside class="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex items-center gap-2">
                <Icon icon="mdi:code-braces" width="18" class="text-zinc-200" />
                <div class="text-sm font-semibold text-zinc-200">代码</div>
              </div>

              <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                <select v-if="availableSnippets.length" :value="langSlug"
                  class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 sm:w-56"
                  @change="selectLang(($event.target as HTMLSelectElement).value)">
                  <option v-for="s in availableSnippets" :key="s.lang_slug" :value="s.lang_slug">
                    {{ s.lang }}
                  </option>
                </select>

                <button
                  class="inline-flex items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
                  :disabled="submitLoading || !langSlug" @click="submitSolution">
                  <Icon icon="mdi:upload" width="18" />
                  {{ submitLoading ? '提交中...' : '提交' }}
                </button>
              </div>
            </div>

            <div v-if="submitError"
              class="mb-3 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200">
              {{ submitError }}
            </div>

            <div v-if="submission" class="mb-3 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div class="font-medium">{{ submission.status_msg || submission.state || '判题中' }}</div>
                <div v-if="submission.runtime" class="text-zinc-400">用时：{{ submission.runtime }}</div>
                <div v-if="submission.memory" class="text-zinc-400">内存：{{ submission.memory }}</div>
                <div v-if="submission.total_testcases != null" class="text-zinc-400">
                  通过：{{ submission.total_correct ?? 0 }}/{{ submission.total_testcases }}
                </div>
              </div>
            </div>

            <div class="h-130 overflow-hidden rounded-md border border-zinc-800">
              <VueMonacoEditor v-model:value="typedCode" :language="codeLanguage" theme="vs-dark" :options="{
                automaticLayout: true,
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
              }" />
            </div>
          </aside>
        </div>
      </section>
    </main>
  </div>
</template>
