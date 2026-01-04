import crypto from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'

const PORT = Number(process.env.PORT || 8787)

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

/**
 * Minimal in-memory session store.
 * sessionId -> { domain, cookie, csrftoken, user, acceptLanguage }
 */
const sessions = new Map()

function extractCookieValue(cookieStr, name) {
    const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, 'i')
    const match = cookieStr.match(re)
    return match ? match[1] : null
}

function getSession(req) {
    const sid = req.cookies.lc_sid
    if (!sid) return null
    return sessions.get(sid) || null
}

function requireSession(req, res) {
    const session = getSession(req)
    if (!session) {
        res.status(401).json({ error: 'NOT_AUTHENTICATED' })
        return null
    }
    return session
}

function setSession(res, session) {
    const sid = crypto.randomUUID()
    sessions.set(sid, session)
    res.cookie('lc_sid', sid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: 1000 * 60 * 60 * 24 * 7,
    })
    return sid
}

function clearSession(req, res) {
    const sid = req.cookies.lc_sid
    if (sid) sessions.delete(sid)
    res.clearCookie('lc_sid', { path: '/' })
}

async function lcFetch(session, path, init = {}) {
    const domain = session?.domain || 'leetcode.com'
    const url = path.startsWith('http') ? path : `https://${domain}${path}`

    const headers = new Headers(init.headers || {})
    if (session?.cookie) headers.set('cookie', session.cookie)
    if (session?.csrftoken) headers.set('x-csrftoken', session.csrftoken)
    if (session?.acceptLanguage && !headers.has('accept-language')) {
        headers.set('accept-language', session.acceptLanguage)
    }
    if (!headers.has('referer')) headers.set('referer', `https://${domain}/`)
    if (!headers.has('origin')) headers.set('origin', `https://${domain}`)

    return fetch(url, {
        ...init,
        headers,
    })
}

async function lcSubmit(session, { titleSlug, questionId, lang, typedCode }) {
    const domain = session?.domain || 'leetcode.com'
    const resp = await lcFetch(session, `/problems/${encodeURIComponent(titleSlug)}/submit/`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            referer: `https://${domain}/problems/${encodeURIComponent(titleSlug)}/`,
        },
        body: JSON.stringify({ lang, question_id: questionId, typed_code: typedCode }),
    })

    const rawText = await resp.text().catch(() => '')
    let json = null
    try {
        json = rawText ? JSON.parse(rawText) : null
    } catch {
        // keep json as null
    }

    if (!resp.ok) {
        return { ok: false, status: resp.status, error: 'HTTP_ERROR', raw: json ?? rawText }
    }

    const submissionId = json?.submission_id ?? json?.submissionId
    if (!submissionId) {
        return { ok: false, status: resp.status, error: 'NO_SUBMISSION_ID', raw: json ?? rawText }
    }

    return { ok: true, status: resp.status, submissionId: Number(submissionId) }
}

async function lcSubmissionCheck(session, submissionId, { titleSlug } = {}) {
    const domain = session?.domain || 'leetcode.com'
    const referer = titleSlug
        ? `https://${domain}/problems/${encodeURIComponent(titleSlug)}/submissions/`
        : `https://${domain}/submissions/detail/${encodeURIComponent(String(submissionId))}/`

    const resp = await lcFetch(session, `/submissions/detail/${encodeURIComponent(String(submissionId))}/check/`, {
        method: 'GET',
        headers: {
            'x-requested-with': 'XMLHttpRequest',
            referer,
        },
    })

    const rawText = await resp.text().catch(() => '')
    let json = null
    try {
        json = rawText ? JSON.parse(rawText) : null
    } catch {
        // keep json as null
    }

    if (!resp.ok) {
        return { ok: false, status: resp.status, error: 'HTTP_ERROR', raw: json ?? rawText }
    }

    return { ok: true, status: resp.status, data: json }
}

const QUERY_USER_COM = `
    query globalData {
        userStatus {
            id: userId
            name: username
            is_signed_in: isSignedIn
            is_premium: isPremium
            is_verified: isVerified
            session_id: activeSessionId
        }
    }
`

const QUERY_USER_CN = `
    query globalData {
        userStatus {
            slug: userSlug
            name: username
            real_name: realName
            is_signed_in: isSignedIn
            is_premium: isPremium
            is_verified: isVerified
        }
    }
`

function isCnDomain(domain) {
    return String(domain || '').toLowerCase().endsWith('leetcode.cn')
}

function normalizeUser(domain, userStatus) {
    if (!userStatus) return null

    const isVerifiedRaw = userStatus.is_verified
    const isVerified =
        typeof isVerifiedRaw === 'boolean' ? isVerifiedRaw : isVerifiedRaw == null ? null : Boolean(isVerifiedRaw)

    if (isCnDomain(domain)) {
        return {
            id: null,
            name: userStatus.name ?? null,
            is_signed_in: Boolean(userStatus.is_signed_in),
            is_premium: Boolean(userStatus.is_premium),
            is_verified: isVerified,
            session_id: null,
            slug: userStatus.slug ?? null,
            real_name: userStatus.real_name ?? null,
        }
    }

    return {
        id: userStatus.id ?? null,
        name: userStatus.name ?? null,
        is_signed_in: Boolean(userStatus.is_signed_in),
        is_premium: Boolean(userStatus.is_premium),
        is_verified: isVerified,
        session_id: userStatus.session_id ?? null,
    }
}

const QUERY_QUESTION = `
  query ($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      id: questionId
      frontend_id: questionFrontendId
      title
            translated_title: translatedTitle
      title_slug: titleSlug
      is_paid_only: isPaidOnly
      difficulty
      likes
      dislikes
      content
            translated_content: translatedContent
      testcase_list: exampleTestcaseList
      topic_tags: topicTags {
        name
        slug
      }
      code_snippets: codeSnippets {
        lang
        lang_slug: langSlug
        code
      }
    }
  }
`

// Some schema variants use titleCn instead of translatedTitle.
const QUERY_QUESTION_TITLECN = `
    query ($titleSlug: String!) {
        question(titleSlug: $titleSlug) {
            id: questionId
            frontend_id: questionFrontendId
            title
            translated_title: titleCn
            title_slug: titleSlug
            is_paid_only: isPaidOnly
            difficulty
            likes
            dislikes
            content
            translated_content: translatedContent
            testcase_list: exampleTestcaseList
            topic_tags: topicTags {
                name
                slug
            }
            code_snippets: codeSnippets {
                lang
                lang_slug: langSlug
                code
            }
        }
    }
`

const QUERY_PROBLEMSET_LIST = `
    query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
        problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
            total
            questions {
                id: questionId
                frontendId: frontendQuestionId
                title
                titleZh: translatedTitle
                titleSlug
                paidOnly: isPaidOnly
                difficulty
                status
                acRate
            }
        }
    }
`

// Some LeetCode schema variants expose Chinese title as `titleCn` instead of `translatedTitle` on list nodes.
const QUERY_PROBLEMSET_LIST_TITLECN = `
    query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
        problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
            total
            questions {
                id: questionId
                frontendId: frontendQuestionId
                title
                titleZh: titleCn
                titleSlug
                paidOnly: isPaidOnly
                difficulty
                status
                acRate
            }
        }
    }
`

async function lcProblemsetQuestionList(session, variables) {
    const first = await lcGraphql(session, QUERY_PROBLEMSET_LIST, variables)
    if (first.ok) return first
    const second = await lcGraphql(session, QUERY_PROBLEMSET_LIST_TITLECN, variables)
    if (second.ok) return second
    return first
}

async function lcGraphql(session, query, variables) {
    const resp = await lcFetch(session, '/graphql/', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
    })

    const text = await resp.text()
    let json
    try {
        json = JSON.parse(text)
    } catch {
        return { ok: false, status: resp.status, error: 'INVALID_JSON', raw: text }
    }

    if (!resp.ok) {
        return { ok: false, status: resp.status, error: 'HTTP_ERROR', raw: json }
    }

    if (json.errors?.length) {
        return { ok: false, status: 200, error: 'GRAPHQL_ERROR', raw: json }
    }

    return { ok: true, status: 200, data: json.data }
}

async function lcQuestion(session, titleSlug) {
    const variables = { titleSlug }
    const first = await lcGraphql(session, QUERY_QUESTION, variables)
    if (first.ok) return first
    const second = await lcGraphql(session, QUERY_QUESTION_TITLECN, variables)
    if (second.ok) return second
    return first
}

app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
})

app.post('/api/auth/cookie', async (req, res) => {
    const cookie = String(req.body?.cookie || '').trim()
    const domain = String(req.body?.domain || 'leetcode.com').trim() || 'leetcode.com'

    if (!cookie) {
        return res.status(400).json({ error: 'COOKIE_REQUIRED' })
    }

    const csrftoken = extractCookieValue(cookie, 'csrftoken')
    const leetcodeSession = extractCookieValue(cookie, 'LEETCODE_SESSION')

    if (!csrftoken || !leetcodeSession) {
        return res.status(400).json({
            error: 'COOKIE_INVALID',
            message: 'Cookie 里需要包含 csrftoken 和 LEETCODE_SESSION。请从浏览器 Network 的 Request Headers 里复制 Cookie。',
        })
    }

    const session = {
        domain,
        cookie,
        csrftoken,
        user: null,
        // Hint LeetCode to return Chinese translations when available.
        acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    const meQuery = isCnDomain(domain) ? QUERY_USER_CN : QUERY_USER_COM
    const me = await lcGraphql(session, meQuery, {})

    if (!me.ok) {
        return res.status(401).json({ error: 'AUTH_FAILED', detail: me })
    }

    const user = normalizeUser(domain, me.data?.userStatus)
    if (!user?.is_signed_in) {
        return res.status(401).json({
            error: 'NOT_SIGNED_IN',
            user,
            message:
                '未检测到登录状态。请确认：1) 你复制的是同域名（leetcode.com / leetcode.cn）的 Request Headers 里的 Cookie；2) Cookie 包含 csrftoken 和 LEETCODE_SESSION；3) 不要把 leetcode.com 的 Cookie 用在 leetcode.cn（反之亦然）。',
        })
    }
    const emailNotVerified = user?.is_verified === false

    session.user = user
    clearSession(req, res)
    setSession(res, session)

    return res.json({ user, emailNotVerified })
})

app.get('/api/auth/me', async (req, res) => {
    const session = requireSession(req, res)
    if (!session) return

    // Refresh user status to detect expired cookies.
    const meQuery = isCnDomain(session.domain) ? QUERY_USER_CN : QUERY_USER_COM
    const me = await lcGraphql(session, meQuery, {})
    if (!me.ok) {
        clearSession(req, res)
        return res.status(401).json({ error: 'SESSION_EXPIRED' })
    }

    session.user = normalizeUser(session.domain, me.data?.userStatus)
    return res.json({ user: session.user })
})

app.post('/api/auth/logout', (req, res) => {
    clearSession(req, res)
    res.json({ ok: true })
})

app.get('/api/problems', async (req, res) => {
    const session = requireSession(req, res)
    if (!session) return

    const q = String(req.query.q || '').trim().toLowerCase()
    const category = String(req.query.category || 'algorithms').trim() || 'algorithms'
    const lang = String(req.query.lang || '').trim().toLowerCase()

    if (lang === 'zh' || lang === 'zh-cn' || lang === 'cn') {
        session.acceptLanguage = 'zh-CN,zh;q=0.9,en;q=0.8'
    }

    // Prefer GraphQL list to get translated titles in one go.
    if (lang === 'zh' || lang === 'zh-cn' || lang === 'cn') {
        const filters = q ? { searchKeywords: q } : {}
        const gql = await lcProblemsetQuestionList(session, {
            categorySlug: category === 'algorithms' ? null : category,
            limit: 2000,
            skip: 0,
            filters,
        })

        const questions = gql.ok ? gql.data?.problemsetQuestionList?.questions : null
        if (Array.isArray(questions) && questions.length) {
            let items = questions.map((x) => {
                const idNum = Number(x.id)
                return {
                    id: Number.isFinite(idNum) ? idNum : 0,
                    frontendId: String(x.frontendId ?? ''),
                    title: x.title ?? '',
                    titleZh: x.titleZh ?? null,
                    titleSlug: x.titleSlug ?? '',
                    paidOnly: Boolean(x.paidOnly),
                    difficulty: x.difficulty || 'Unknown',
                    status: x.status || null,
                    acRate: typeof x.acRate === 'number' ? x.acRate : x.acRate == null ? null : Number(x.acRate),
                }
            })

            // If logged in on leetcode.com and translations are missing, try filling from leetcode.cn (public).
            const needCnFill =
                String(session.domain || '').toLowerCase().endsWith('leetcode.com') &&
                items.some((it) => !it.titleZh && it.titleSlug)

            if (needCnFill) {
                const cnSession = {
                    domain: 'leetcode.cn',
                    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
                }
                const cnGql = await lcProblemsetQuestionList(cnSession, {
                    categorySlug: category === 'algorithms' ? null : category,
                    limit: 2000,
                    skip: 0,
                    filters,
                })

                const cnQuestions = cnGql.ok ? cnGql.data?.problemsetQuestionList?.questions : null
                if (Array.isArray(cnQuestions) && cnQuestions.length) {
                    const cnMap = new Map(
                        cnQuestions
                            .filter((x) => x?.titleSlug)
                            .map((x) => [String(x.titleSlug), x.titleZh ?? null])
                    )

                    items = items.map((it) => {
                        if (it.titleZh) return it
                        const zh = cnMap.get(it.titleSlug)
                        return zh ? { ...it, titleZh: zh } : it
                    })
                }
            }

            return res.json({ items })
        }
        // If GraphQL fails (schema/cookie/upstream), fall back to REST below.
    }

    const resp = await lcFetch(session, `/api/problems/${encodeURIComponent(category)}/`, {
        method: 'GET',
    })

    if (!resp.ok) {
        const raw = await resp.text().catch(() => '')
        return res.status(502).json({ error: 'UPSTREAM_ERROR', status: resp.status, raw })
    }

    const raw = await resp.json()
    const pairs = Array.isArray(raw?.stat_status_pairs) ? raw.stat_status_pairs : []

    const difficultyMap = {
        1: 'Easy',
        2: 'Medium',
        3: 'Hard',
    }

    let items = pairs.map((p) => {
        const stat = p.stat || {}
        const level = p.difficulty?.level
        const totalAcs = Number(stat.total_acs || 0)
        const totalSubmitted = Number(stat.total_submitted || 0)
        const acRate = totalSubmitted > 0 ? (totalAcs / totalSubmitted) * 100 : null

        return {
            id: stat.question_id,
            frontendId: String(stat.frontend_question_id ?? ''),
            title: stat.question__title,
            titleZh: null,
            titleSlug: stat.question__title_slug,
            paidOnly: Boolean(p.paid_only),
            difficulty: difficultyMap[level] || 'Unknown',
            status: p.status || null,
            acRate,
        }
    })

    if (q) {
        items = items.filter((x) => {
            const t = String(x.title || '').toLowerCase()
            const s = String(x.titleSlug || '').toLowerCase()
            return t.includes(q) || s.includes(q) || String(x.frontendId).includes(q)
        })
    }

    res.json({ items })
})

app.get('/api/problem/:slug', async (req, res) => {
    const session = requireSession(req, res)
    if (!session) return

    const slug = String(req.params.slug || '').trim()
    if (!slug) return res.status(400).json({ error: 'SLUG_REQUIRED' })

    const resp = await lcQuestion(session, slug)
    if (!resp.ok) {
        return res.status(502).json({ error: 'UPSTREAM_ERROR', detail: resp })
    }

    const q = resp.data?.question
    if (!q) return res.status(404).json({ error: 'NOT_FOUND' })

    // If logged in on leetcode.com but Chinese translation is missing, try leetcode.cn (public) as a fallback.
    const missingZh = !q.translated_title && !q.translated_content
    const isCom = String(session.domain || '').toLowerCase().endsWith('leetcode.com')
    if (isCom && missingZh) {
        const cnSession = {
            domain: 'leetcode.cn',
            acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
        }
        const cn = await lcQuestion(cnSession, slug)
        const cnQ = cn.ok ? cn.data?.question : null
        if (cnQ) {
            q.translated_title = cnQ.translated_title || cnQ.title || q.translated_title
            q.translated_content = cnQ.translated_content || cnQ.content || q.translated_content
        }
    }

    res.json({ question: q })
})

app.post('/api/submit', async (req, res) => {
    const session = requireSession(req, res)
    if (!session) return

    const titleSlug = String(req.body?.slug || '').trim()
    const lang = String(req.body?.lang || '').trim()
    const typedCode = String(req.body?.code || '')
    let questionId = req.body?.questionId
    if (questionId != null) questionId = String(questionId)

    if (!titleSlug) return res.status(400).json({ error: 'SLUG_REQUIRED' })
    if (!lang) return res.status(400).json({ error: 'LANG_REQUIRED' })
    if (!typedCode) return res.status(400).json({ error: 'CODE_REQUIRED' })

    if (!questionId) {
        const q = await lcQuestion(session, titleSlug)
        if (!q.ok) return res.status(502).json({ error: 'UPSTREAM_ERROR', detail: q })
        questionId = q.data?.question?.id
        if (!questionId) return res.status(502).json({ error: 'UPSTREAM_ERROR', message: 'Missing questionId' })
    }

    const submit = await lcSubmit(session, { titleSlug, questionId, lang, typedCode })
    if (!submit.ok) {
        return res.status(502).json({ error: 'UPSTREAM_ERROR', detail: submit })
    }

    res.json({ submissionId: submit.submissionId })
})

app.get('/api/submission/:id/check', async (req, res) => {
    const session = requireSession(req, res)
    if (!session) return

    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'INVALID_SUBMISSION_ID' })

    const titleSlug = String(req.query.slug || '').trim() || undefined
    const check = await lcSubmissionCheck(session, id, { titleSlug })
    if (!check.ok) {
        return res.status(502).json({ error: 'UPSTREAM_ERROR', detail: check })
    }

    res.json({ submission: check.data })
})

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[lc-proxy] listening on http://localhost:${PORT}`)
})
