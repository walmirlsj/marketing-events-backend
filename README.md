# Marketing Events Platform — Documentação Técnica

## Visão Geral

Plataforma completa para registro, classificação e governança de eventos de marketing na América Latina. Permite cadastro manual ou via upload de CSV/Excel, classifica automaticamente o território com base no país, e gerencia um fluxo de aprovação com notificações automáticas.

---

## Stack Tecnológica

| Camada     | Tecnologia                                      |
|------------|-------------------------------------------------|
| Frontend   | React 18 + Vite + React Router + TanStack Query |
| Estado     | Zustand (auth) + React Query (server state)     |
| Backend    | Node.js + Express                               |
| Banco      | PostgreSQL (produção) / SQLite (desenvolvimento)|
| Auth       | JWT (jsonwebtoken) + bcryptjs                   |
| E-mail     | Nodemailer                                      |
| Upload     | Multer                                          |
| CSV/Excel  | PapaParse + xlsx                                |

---

## Estrutura de Pastas

```
marketing-events/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   └── database.js          # Pool de conexão PostgreSQL
│   │   ├── controllers/
│   │   │   ├── authController.js    # Login, registro, perfil
│   │   │   └── eventsController.js  # CRUD + importação + aprovação
│   │   ├── middleware/
│   │   │   └── auth.js              # JWT verify + role guard
│   │   ├── routes/
│   │   │   └── index.js             # Todos os endpoints REST
│   │   ├── services/
│   │   │   ├── territoryService.js  # 🗺️ Classificação de território
│   │   │   ├── notificationService.js # 🔔 E-mail + in-app
│   │   │   └── importService.js     # 📂 CSV/XLSX parser
│   │   ├── utils/
│   │   │   ├── migrate.js           # Script de migração do banco
│   │   │   └── seed.js              # Dados iniciais (regiões + admin)
│   │   └── server.js                # Entry point Express
│   ├── .env.example
│   └── package.json
│
└── frontend/
    ├── src/
    │   ├── components/
    │   │   └── Layout.jsx           # Sidebar + topbar + notificações
    │   ├── pages/
    │   │   ├── LoginPage.jsx
    │   │   ├── RegisterPage.jsx
    │   │   ├── EventsPage.jsx       # Grid com filtros
    │   │   ├── EventDetailPage.jsx  # Detalhes + convidados
    │   │   ├── NewEventPage.jsx     # Formulário + import tab
    │   │   ├── AdminPage.jsx        # Painel de aprovação
    │   │   └── CalendarPage.jsx     # Calendário mensal
    │   ├── services/
    │   │   └── api.js               # Axios + interceptors
    │   ├── store/
    │   │   └── authStore.js         # Zustand auth state
    │   ├── App.jsx
    │   └── main.jsx
    ├── index.html
    └── vite.config.js
```

---

## Banco de Dados

### Diagrama de Entidades

```
users ──────────────────────────────────────────────────────┐
│ id, name, email, password_hash, role (user|admin)          │
└───────────────────────────────────────────────────────────┘
       │ created_by              │ reviewed_by
       ▼                         ▼
events ─────────────────────────────────────────────────────┐
│ id, name, description, city, country                       │
│ territory (auto-classificado), status (pending|approved    │
│ |rejected), event_date, source (manual|csv|xlsx)           │
│ rejection_reason, reviewed_at                              │
└───────────────────────────────────────────────────────────┘
       │ 1:N
       ▼
event_guests
│ id, event_id, guest_name, guest_email
└───────────────────────

regions (tabela auxiliar — separador: ;)
│ id, country_name, country_code, territory
└───────────────────────

notifications
│ id, user_id, event_id, type, title, message, read
└───────────────────────
```

---

## Classificação de Território

O `territoryService.js` classifica automaticamente o território em duas etapas:

1. **Consulta ao banco** — busca exata e parcial (case-insensitive) na tabela `regions`
2. **Fallback estático** — mapeamento em memória caso o banco não encontre

### Territórios e Países

| Território | Países                                                        |
|------------|---------------------------------------------------------------|
| Brazil     | Brazil, Brasil                                                |
| Mexico     | Mexico, México                                                |
| NOLA       | Colombia, Venezuela, Ecuador, Panamá, Costa Rica, Guatemala, Honduras, El Salvador, Nicaragua, República Dominicana, Cuba, Haiti, Jamaica, Trinidad e Tobago, Bolívia, Puerto Rico |
| SOLA       | Argentina, Chile, Uruguai, Paraguai, Peru                     |

### Importar nova tabela de regiões (CSV com separador ;)

```
country_name;country_code;territory
Brazil;BR;Brazil
Colombia;CO;NOLA
Argentina;AR;SOLA
```

Endpoint: `POST /api/regions/import` (admin)

---

## Fluxo de Governança

```
Cadastro (qualquer usuário)
        │
        ▼
  Status: PENDING
        │
        ▼
  Admin revisa no Painel
        │
   ┌────┴────┐
APPROVE   REJECT
   │           │
   ▼           ▼
APPROVED   REJECTED
(Base Oficial)  │
(Calendário)    │
        ┌───────┴───────┐
        │               │
  E-mail enviado   In-app notif.
  ao cadastrador   criada no banco
```

---

## API — Endpoints

### Auth
| Método | Rota             | Auth | Descrição            |
|--------|------------------|------|----------------------|
| POST   | /auth/register   | —    | Cria conta           |
| POST   | /auth/login      | —    | Login → JWT          |
| GET    | /auth/me         | ✓    | Perfil do usuário    |

### Events
| Método | Rota                  | Auth    | Descrição                          |
|--------|-----------------------|---------|------------------------------------|
| GET    | /events               | opt.    | Lista eventos (aprovados por padrão)|
| GET    | /events/:id           | opt.    | Detalhes de um evento              |
| POST   | /events               | opt.    | Cria evento manual (→ pending)     |
| POST   | /events/import        | ✓       | Importa CSV/Excel                  |
| PATCH  | /events/:id/review    | admin   | Aprova ou rejeita evento           |
| GET    | /admin/events/pending | admin   | Lista eventos pendentes            |

### Regiões
| Método | Rota            | Auth  | Descrição                     |
|--------|-----------------|-------|-------------------------------|
| GET    | /regions        | —     | Lista tabela auxiliar         |
| POST   | /regions/import | admin | Importa CSV de regiões (sep ;)|

### Notificações
| Método | Rota                  | Auth | Descrição                  |
|--------|-----------------------|------|----------------------------|
| GET    | /notifications        | ✓    | Lista notificações do user |
| PATCH  | /notifications/read   | ✓    | Marca como lidas           |

---

## Como Executar

### Pré-requisitos
- Node.js 18+
- PostgreSQL 14+

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edite .env com suas credenciais
npm install
npm run db:migrate   # Cria tabelas
npm run db:seed      # Popula regiões + cria admin
npm run dev          # http://localhost:3001
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

### 3. Login inicial

```
E-mail: admin@marketingevents.com
Senha:  admin123
Role:   admin
```

---

## Formato do CSV de Importação

**Separador: ponto e vírgula (;)**

```csv
nome_evento;descricao;cidade;pais;convidados;data
Summit LATAM 2025;Evento anual;São Paulo;Brazil;João Silva,Maria Oliveira;2025-03-15
```

- Múltiplos convidados: separar por vírgula dentro da coluna `convidados`
- Coluna `data`: formato `YYYY-MM-DD`
- Colunas aceitas em português ou inglês (case-insensitive)
- Território é classificado automaticamente pelo país

---

## Variáveis de Ambiente

```env
# Banco
DATABASE_URL=postgresql://user:pass@localhost:5432/marketing_events

# JWT
JWT_SECRET=chave_secreta_longa_e_aleatoria
JWT_EXPIRES_IN=7d

# E-mail (Nodemailer)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=seu@email.com
EMAIL_PASS=senha_de_app_gmail

# URLs
FRONTEND_URL=http://localhost:5173
PORT=3001
```

---

## Próximos Passos (Roadmap)

- [ ] Exportação da Base Oficial para Excel/PDF
- [ ] Filtros avançados no calendário por território
- [ ] Dashboard com métricas (eventos por território/mês)
- [ ] Integração com Slack para notificações de admin
- [ ] Autenticação SSO (Google / Microsoft)
- [ ] Edição de eventos pendentes pelo cadastrador
- [ ] Histórico de aprovações por auditor
