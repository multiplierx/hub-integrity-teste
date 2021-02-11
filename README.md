<br />
<h2 align="center">@multiplierx/hub-integrity</h2>
<br />  

O objetivo deste package é evitar que colunas seram `excluidas`, `renomeadas`, `adicionadas` sem o conhecimento da equipe.

Através de dumps programados da estrutura de cada banco de dados/tabelas da Multiplier, ele analisa alterações que ocorreram entre um determinado período de tempo, e caso algum dado tenha alterado, abre uma `Issue no Github` para que o time saiba da alteração.

  ## Requisitos
- Github Access Token - https://github.com/settings/tokens/new
- As labels devem ser criadas antes de serem utilizadas.
- Os assignees devem ter permissão `push` para poderem ser incluídos. Serão ignorados caso contrário.

## Instalação
```bash
$ yarn add @multiplierx/hub-integrity
```

Crie um arquivo `index.js` com o seguinte conteúdo:

```js
	const { Integrity } = require('@multiplierx/hub-integrity')
	require('dotenv').config()
	
	const integrity =  new  Integrity({
		host: process.env.DB_HOST,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_DATABASE
	}, {
		token: process.env.GITHUB_PERSONAL_TOKEN,
		repo:  'hub-integrity', // Nome do repositório que será gerado as issues
		owner:  'saade' // Owner do repositório (multiplierx)
	}, {
		labels: ['needs migration', 'database change'],
		assignees: ['saade']
	})
	
	await integrity.schedule('0 */1 * * *') // Rodar a cada 1 hora
	// ou
	await integrity.run() // Rodar apenas 1 vez
```
  
```bash
$ node index.js
```

<br/>

## TODO
- [ ] Permitir a personalização do título e conteúdo da issue.
- [ ] Adicionar Whitelist / Blacklist de tabelas
- [ ] Refatorar algumas partes do código (este projeto é apenas um MVP).
- [ ] Criar bot para github actions toda vez que uma migration é alterada / criada.
- [ ] Melhorar logs