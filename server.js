// server.js - Versão com ID do laboratório integrado ao número do certificado
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Connexion MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sns';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Erro MongoDB:', err));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== Modèles ==========
const PROVINCIAS = [
  'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango',
  'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla',
  'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico',
  'Namibe', 'Uíge', 'Zaire'
];

const establishmentSchema = new mongoose.Schema({
  establishmentType: { type: String, enum: ['laboratorio', 'hospital', 'empresa', 'ong'], required: true, index: true },
  name: { type: String, required: true, trim: true },
  nif: { type: String, required: true, unique: true, trim: true },
  institutionType: { type: String, enum: ['Público', 'Privado'], required: true },
  province: { type: String, required: true, enum: PROVINCIAS },
  municipality: { type: String, required: true, trim: true },
  address: { type: String, required: true, trim: true },
  phone1: { type: String, required: true, trim: true },
  phone2: { type: String, trim: true },
  email: { type: String, lowercase: true, trim: true },
  director: { type: String, required: true, trim: true },
  technicalResponsible: { type: String, required: true, trim: true },
  licenseNumber: { type: String, required: true, trim: true },
  licenseValidity: { type: Date, required: true },
  keyHash: { type: String, required: true, unique: true },
  keyPrefix: { type: String, default: 'SNS-', index: true },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

establishmentSchema.virtual('status').get(function() {
  if (!this.isActive) return 'Inativo';
  return this.licenseValidity < new Date() ? 'Inativo' : 'Ativo';
});

const Establishment = mongoose.model('Establishment', establishmentSchema);

// Schema Certificate (sans hook pre-save)
const certificateSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true, index: true },
  createdBy: { type: String },
  certificateNumber: { type: String, required: true, unique: true },
  patientName: { type: String, required: true },
  patientId: { type: String },
  patientBirthDate: { type: Date },
  diseaseCategory: { type: String, required: true },
  diagnosis: { type: String, required: true },
  testDate: { type: Date, default: Date.now },
  testResults: { type: mongoose.Schema.Types.Mixed },
  idadeCalculada: Number,
  imcCalculado: Number,
  classificacaoIMC: String
}, { timestamps: true });

certificateSchema.index({ createdAt: -1 });
certificateSchema.index({ patientName: 'text' });

const Certificate = mongoose.model('Certificate', certificateSchema);

// ========== Utilitaires ==========
// Génère un numéro de certificat ultra-robuste avec ID du laboratoire
function gerarNumeroCertificado(labId) {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = (agora.getMonth() + 1).toString().padStart(2, '0');
  const dia = agora.getDate().toString().padStart(2, '0');
  const hora = agora.getHours().toString().padStart(2, '0');
  const min = agora.getMinutes().toString().padStart(2, '0');
  const seg = agora.getSeconds().toString().padStart(2, '0');
  const ms = agora.getMilliseconds().toString().padStart(3, '0');
  
  // Extrait une partie unique de l'ID du laboratoire (les 4 derniers caractères hex)
  const labPart = labId.toString().slice(-4).toUpperCase();
  
  // 6 bytes aléatoires => 12 caractères hex (sécurité renforcée)
  const random = crypto.randomBytes(6).toString('hex').toUpperCase();
  
  // Format: CERT-AAAAMMJJ-LABPART-HHMMSSmmm-RANDOM
  return `CERT-${ano}${mes}${dia}-${labPart}-${hora}${min}${seg}${ms}-${random}`;
}

function calcularIdade(dataNascimento) {
  if (!dataNascimento) return null;
  const hoje = new Date();
  const nasc = new Date(dataNascimento);
  let idade = hoje.getFullYear() - nasc.getFullYear();
  const m = hoje.getMonth() - nasc.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < nasc.getDate())) idade--;
  return idade;
}

function calcularIMC(peso, altura) {
  if (!peso || !altura || altura <= 0) return { imc: null, classificacao: null };
  const imc = peso / (altura * altura);
  let classificacao = '';
  if (imc < 18.5) classificacao = 'Abaixo do peso';
  else if (imc < 25) classificacao = 'Peso normal';
  else if (imc < 30) classificacao = 'Sobrepeso';
  else if (imc < 35) classificacao = 'Obesidade grau I';
  else if (imc < 40) classificacao = 'Obesidade grau II';
  else classificacao = 'Obesidade grau III';
  return { imc: imc.toFixed(2), classificacao };
}

// ========== Middleware JWT ==========
const authJWT = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
    const lab = await Establishment.findById(decoded.id);
    if (!lab) return res.status(401).json({ erro: 'Laboratório não encontrado' });
    if (lab.status === 'Inativo') return res.status(403).json({ erro: 'Laboratório inativo' });
    req.lab = lab;
    next();
  } catch (err) {
    return res.status(403).json({ erro: 'Token inválido' });
  }
};

// ========== Routes HTML ==========
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Login Laboratório</title>
  <style>body{background:#006633;font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}.box{background:white;padding:30px;border-radius:10px;width:300px;box-shadow:0 5px 15px rgba(0,0,0,0.3);}h2{text-align:center;color:#006633;margin-bottom:20px;}input,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box;border-radius:5px;border:1px solid #ddd;}button{background:#006633;color:white;border:none;font-weight:bold;cursor:pointer;}button:hover{background:#004d26;}.erro{color:#c00;text-align:center;margin-top:10px;}</style>
</head>
<body>
<div class="box"><h2>🔬 Laboratório SNS</h2><input type="text" id="apiKey" placeholder="Chave API (LAB-...)" autofocus><button onclick="login()">Entrar</button><p id="erro" class="erro"></p></div>
<script>
async function login(){
  const key=document.getElementById('apiKey').value;
  const erro=document.getElementById('erro');
  if(!key){ erro.innerText='Digite a chave API'; return; }
  try{
    const r=await fetch('/api/laboratorio/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({apiKey:key})
    });
    const data=await r.json();
    if(r.ok){
      localStorage.setItem('token',data.token);
      localStorage.setItem('labNome',data.lab.nome);
      window.location.href='/dashboard';
    } else {
      erro.innerText=data.erro||'Erro na autenticação';
    }
  }catch(e){ erro.innerText='Erro de ligação ao servidor'; }
}
</script>
</body></html>
  `);
});

app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard Laboratório</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Segoe UI',sans-serif; }
    body { background:#f5f7fa; display:flex; min-height:100vh; }
    .sidebar { width:260px; background:#006633; color:white; padding:2rem 1rem; display:flex; flex-direction:column; }
    .sidebar h2 { font-size:1.5rem; margin-bottom:2rem; text-align:center; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:1rem; }
    .sidebar a, .sidebar button { display:block; width:100%; padding:0.8rem 1rem; margin:0.5rem 0; border:none; background:rgba(255,255,255,0.1); color:white; text-align:left; border-radius:8px; cursor:pointer; font-size:1rem; text-decoration:none; }
    .sidebar a:hover, .sidebar button:hover { background:rgba(255,255,255,0.2); }
    .sidebar .novo-btn { background:#ffaa00; color:#00331a; font-weight:bold; }
    .sidebar .sair-btn { margin-top:auto; background:#c0392b; }
    .main { flex:1; padding:2rem; overflow-y:auto; }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:1.5rem; margin-bottom:2rem; }
    .card { background:white; border-radius:12px; padding:1.5rem; box-shadow:0 4px 10px rgba(0,0,0,0.05); border-left:6px solid #006633; }
    .card .numero { font-size:2.5rem; font-weight:bold; color:#006633; }
    .filtros { display:flex; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .filtros select, .filtros input { padding:0.8rem; border:1px solid #ddd; border-radius:8px; flex:1; }
    table { width:100%; border-collapse:collapse; background:white; border-radius:12px; overflow:hidden; }
    th { background:#006633; color:white; padding:1rem; text-align:left; }
    td { padding:1rem; border-bottom:1px solid #eee; }
    .btn { background:#006633; color:white; border:none; padding:0.5rem 1rem; border-radius:6px; cursor:pointer; }
    .badge { background:#e8f5e9; color:#2e7d32; padding:0.2rem 0.5rem; border-radius:20px; font-size:0.8rem; }
  </style>
</head>
<body>
<div class="sidebar">
  <h2>SNS • LAB</h2>
  <a href="#" onclick="mostrarSecao('dashboard')">📊 Dashboard</a>
  <a href="#" onclick="mostrarSecao('certificados')">📜 Certificados</a>
  <a href="#" class="novo-btn" onclick="window.location.href='/novo-certificado'">➕ Novo Certificado</a>
  <button class="sair-btn" onclick="logout()">🚪 Sair</button>
</div>
<div class="main">
  <div class="header"><h1>Bem-vindo, <span id="labNome"></span></h1><span id="dataAtual"></span></div>
  <div id="secaoDashboard" style="display:block;">
    <div class="cards">
      <div class="card"><h3>Total de Certificados</h3><div class="numero" id="totalCert">0</div></div>
      <div class="card"><h3>Por Tipo</h3><div id="statsTipo"></div></div>
    </div>
  </div>
  <div id="secaoCertificados" style="display:none;">
    <div class="filtros">
      <select id="filtroTipo">
        <option value="">Todos os tipos</option>
        <option value="1">Genótipo</option><option value="2">Boa Saúde</option><option value="3">Incapacidade</option>
        <option value="4">Aptidão</option><option value="5">Saúde Materna</option><option value="6">Pré-Natal</option>
        <option value="7">Epidemiológico</option><option value="8">CSD</option>
      </select>
      <input type="text" id="buscaPaciente" placeholder="Buscar paciente...">
      <button class="btn" onclick="carregarCertificados()">Filtrar</button>
    </div>
    <table>
      <thead><tr><th>Nº Certificado</th><th>Paciente</th><th>Tipo</th><th>Data</th><th>Ações</th></tr></thead>
      <tbody id="tabelaCertificados"><tr><td colspan="5" style="text-align:center;">Carregando...</td></tr></tbody>
    </table>
  </div>
</div>
<script>
const token = localStorage.getItem('token');
if (!token) window.location.href = '/';
document.getElementById('labNome').innerText = localStorage.getItem('labNome') || 'Laboratório';
document.getElementById('dataAtual').innerText = new Date().toLocaleDateString('pt-PT');
function mostrarSecao(secao) {
  document.getElementById('secaoDashboard').style.display = secao === 'dashboard' ? 'block' : 'none';
  document.getElementById('secaoCertificados').style.display = secao === 'certificados' ? 'block' : 'none';
  if (secao === 'dashboard') carregarStats();
  if (secao === 'certificados') carregarCertificados();
}
async function carregarStats() {
  try {
    const r = await fetch('/api/laboratorio/stats', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await r.json();
    document.getElementById('totalCert').innerText = data.total;
    let html = '';
    data.porTipo.forEach(item => { html += '<div><span class="badge">' + (item._id || 'Sem tipo') + '</span> ' + item.count + '</div>'; });
    document.getElementById('statsTipo').innerHTML = html || '<div>Nenhum dado</div>';
  } catch (e) { console.error(e); }
}
async function carregarCertificados() {
  const tipo = document.getElementById('filtroTipo').value;
  const busca = document.getElementById('buscaPaciente').value;
  let url = '/api/laboratorio/certificados';
  const params = new URLSearchParams();
  if (tipo) params.append('tipo', tipo);
  if (busca) params.append('paciente', busca);
  if (params.toString()) url += '?' + params.toString();
  try {
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const certs = await r.json();
    let html = '';
    if (certs.length === 0) html = '<tr><td colspan="5" style="text-align:center;">Nenhum certificado</td></tr>';
    else {
      certs.forEach(c => {
        html += '<tr><td>' + c.certificateNumber + '</td><td>' + c.patientName + '</td><td>' + (c.diseaseCategory || '—') + '</td><td>' + new Date(c.createdAt).toLocaleDateString('pt-PT') + '</td><td><button class="btn" onclick="baixarPDF(\\'' + c._id + '\\')">📄 PDF</button></td></tr>';
      });
    }
    document.getElementById('tabelaCertificados').innerHTML = html;
  } catch (e) { document.getElementById('tabelaCertificados').innerHTML = '<tr><td colspan="5" style="text-align:center;">Erro ao carregar</td></tr>'; }
}
async function baixarPDF(id) {
  try {
    const r = await fetch('/api/laboratorio/certificados/' + id + '/pdf', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'certificado.pdf';
    a.click();
  } catch (e) { alert('Erro ao gerar PDF'); }
}
function logout() { localStorage.clear(); window.location.href = '/'; }
carregarStats();
</script>
</body></html>
  `);
});

// ========== ROTA /novo-certificado COM SELETORES DE DATA ==========
app.get('/novo-certificado', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Novo Certificado</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Segoe UI',sans-serif; }
    body { background:#f0f4f0; display:flex; justify-content:center; align-items:flex-start; min-height:100vh; padding:2rem; }
    .container { max-width:950px; width:100%; background:white; border-radius:24px; padding:2rem; }
    .header { background:#006633; color:white; padding:1.5rem; border-radius:12px 12px 0 0; }
    .header h1 { font-size:2rem; }
    .header span { background:#ffcc00; color:#006633; padding:4px 12px; border-radius:40px; }
    .form-card { padding:2rem; }
    .section-title { font-size:1.4rem; font-weight:600; color:#006633; border-bottom:2px solid #cce8d5; margin:2rem 0 1rem; }
    .grid-2 { display:grid; grid-template-columns:repeat(2,1fr); gap:1.5rem; }
    .campo { display:flex; flex-direction:column; }
    .full-width { grid-column:span 2; }
    label { font-weight:600; color:#2d4a3b; }
    input, select { padding:0.8rem; border:1px solid #ddd; border-radius:8px; }
    .btn-emitir { background:#006633; color:white; border:none; padding:1rem; border-radius:50px; width:100%; cursor:pointer; font-size:1.2rem; }
    .campos-dinamicos { background:#fafdfb; padding:1.5rem; border:1px dashed #99bbaa; border-radius:12px; }
    .info-message { background:#e0f0e5; padding:1rem; border-radius:8px; }
    #modalPreview { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:none; justify-content:center; align-items:center; }
    .modal-content { background:white; padding:2rem; border-radius:24px; max-width:600px; }
    .data-container { display:flex; gap:5px; }
    .data-container select, .data-container input { flex:1; }
  </style>
</head>
<body>
<div class="container">
  <div class="header"><h1>➕ Novo Certificado <span>LAB</span></h1></div>
  <div class="form-card">
    <div id="loadingMessage" class="info-message">A validar...</div>
    <form id="certForm" style="display:none;">
      <!-- Tipo de certificado (sempre no topo) -->
      <div>
        <label for="tipo">TIPO DE CERTIFICADO *</label>
        <select id="tipo" required>
          <option value="" disabled selected>— Selecione —</option>
          <option value="1">1 - GENÓTIPO</option><option value="2">2 - BOA SAÚDE</option><option value="3">3 - INCAPACIDADE</option>
          <option value="4">4 - APTIDÃO</option><option value="5">5 - SAÚDE MATERNA</option><option value="6">6 - PRÉ-NATAL</option>
          <option value="7">7 - EPIDEMIOLÓGICO</option><option value="8">8 - CSD</option>
        </select>
      </div>

      <!-- Dados do paciente -->
      <div class="section-title">👤 Dados do paciente</div>
      <div class="grid-2">
        <div class="full-width campo"><label>Nome completo *</label><input type="text" id="nomeCompleto" required></div>
        <div class="campo"><label>BI</label><input type="text" id="bi"></div>
        <div class="campo"><label>Género</label><select id="genero"><option value="M">Masculino</option><option value="F" selected>Feminino</option></select></div>
        <div class="full-width campo"><label>Data de Nascimento *</label>
          <div class="data-container">
            <select id="dia" required>
              <option value="">Dia</option>
            </select>
            <select id="mes" required>
              <option value="">Mês</option>
              <option value="1">Janeiro</option>
              <option value="2">Fevereiro</option>
              <option value="3">Março</option>
              <option value="4">Abril</option>
              <option value="5">Maio</option>
              <option value="6">Junho</option>
              <option value="7">Julho</option>
              <option value="8">Agosto</option>
              <option value="9">Setembro</option>
              <option value="10">Outubro</option>
              <option value="11">Novembro</option>
              <option value="12">Dezembro</option>
            </select>
            <input type="number" id="ano" placeholder="Ano" min="1900" max="2100" required>
          </div>
        </div>
        <div class="full-width campo"><label>Telefone</label><input type="tel" id="telefone"></div>
      </div>

      <!-- Parâmetros específicos (campos dinâmicos) -->
      <div class="section-title">📋 Parâmetros específicos</div>
      <div class="campos-dinamicos" id="camposEspecificosContainer">
        <p class="info-message">👆 Selecione um tipo para ver os campos.</p>
      </div>

      <!-- Responsável pela emissão (agora no final) -->
      <div class="section-title">🔬 Responsável pela emissão</div>
      <div class="grid-2">
        <div class="full-width campo"><label>Nome do laborantin / técnico *</label><input type="text" id="laborantinNome" required></div>
        <div class="campo"><label>Registro profissional</label><input type="text" id="laborantinRegistro"></div>
      </div>

      <button type="submit" class="btn-emitir" id="btnEmitir">📥 Emitir certificado</button>
    </form>
    <div id="resultadoArea" class="hidden" style="display:none;"></div>
  </div>
</div>

<div id="modalPreview">
  <div class="modal-content">
    <h2 style="color:#006633;">🔍 Confirmar Dados</h2>
    <div id="previewContent"></div>
    <div style="display:flex; gap:1rem; margin-top:2rem;">
      <button type="button" onclick="fecharPreview()" style="flex:1; background:#f0f0f0; padding:1rem; border-radius:50px;">Modificar</button>
      <button type="button" id="btnConfirmarFinal" style="flex:1; background:#006633; color:white; padding:1rem; border-radius:50px;">Confirmar</button>
    </div>
  </div>
</div>

<script>
// Lista completa de exames por tipo (8 tipos)
const examesPorTipo = {
  1: ['grupoSanguineo','fatorRh','genotipo','hemoglobina','hematocrito','contagem_reticulocitos','eletroforese'],
  2: ['peso','altura','pressaoArterial','frequenciaCardiaca','frequenciaRespiratoria','temperatura','saturacaoOxigenio','glicemia','colesterolTotal','triglicerideos'],
  3: ['tipoIncapacidade','causa','grau','dataInicio','partesAfetadas','limitacoes','necessitaAcompanhante'],
  4: ['tipoAptidao','modalidade','resultado','restricoes','validade'],
  5: ['gestacoes','partos','abortos','nascidosVivos','dum','dpp','idadeGestacional','consultasCPN','hemograma','gotaEspessa','hiv','vdrl','hbs','glicemia','creatinina','ureia','tgo','grupoSanguineo','fatorRh','exsudadoVaginal','pesoAtual','alturaUterina','batimentosCardiacosFeto','movimentosFetais','edema','proteinuria'],
  6: ['grupoSanguineo','fatorRh','hemograma','gotaEspessa','hiv','vdrl','hbs','vidal','glicemia','creatinina','ureia','tgo','testeGravidez','exsudadoVaginal','vs','falsiformacao'],
  7: ['doenca','outraDoenca','dataInicioSintomas','dataDiagnostico','metodoDiagnostico','tipoExame','resultado','tratamento','internamento','dataInternamento','contatos'],
  8: ['destino','motivoViagem','dataPartida','dataRetorno','vacinaFebreAmarela','dataVacinaFebreAmarela','loteVacinaFebreAmarela','vacinaCovid19','dosesCovid','testeCovid','tipoTesteCovid','dataTesteCovid','resultadoTesteCovid','outrasVacinas','medicamentos','condicoesEspeciais','recomendacoes']
};
const opcoesSelect = {
  'grupoSanguineo': ['A','B','AB','O'],
  'fatorRh': ['Positivo (+)','Negativo (-)'],
  'genotipo': ['AA','AS','SS','AC','SC'],
  'tipoIncapacidade': ['Física','Mental','Sensorial','Múltipla'],
  'grau': ['Leve','Moderado','Grave'],
  'tipoAptidao': ['Apto','Inapto','Apto com restrições'],
  'modalidade': ['Desportiva','Laboral','Escolar'],
  'resultado': ['Positivo','Negativo','Inconclusivo'],
  'metodoDiagnostico': ['Clínico','Laboratorial','Imagem'],
  'tipoExame': ['PCR','Antigénio','Sorologia'],
  'vacinaFebreAmarela': ['Sim','Não'],
  'vacinaCovid19': ['Sim','Não'],
  'testeCovid': ['Sim','Não']
};

function formatarNomeCampo(chave) {
  return chave.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
}

// Função para obter número de dias em um mês/ano
function getDiasNoMes(mes, ano) {
  return new Date(ano, mes, 0).getDate();
}

// Atualiza os dias conforme mês e ano
function atualizarDias() {
  const mes = parseInt(document.getElementById('mes').value);
  const ano = parseInt(document.getElementById('ano').value);
  const selectDia = document.getElementById('dia');
  const diaAtual = selectDia.value;
  selectDia.innerHTML = '<option value="">Dia</option>';
  if (mes && ano) {
    const dias = getDiasNoMes(mes, ano);
    for (let i = 1; i <= dias; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = i.toString().padStart(2, '0');
      selectDia.appendChild(opt);
    }
    if (diaAtual && parseInt(diaAtual) <= dias) {
      selectDia.value = diaAtual;
    }
  }
}

// Token e inicialização
const token = localStorage.getItem('token');
if (!token) {
  document.getElementById('loadingMessage').innerText = '❌ Sessão expirada';
  setTimeout(() => window.location.href = '/', 2000);
} else {
  document.getElementById('loadingMessage').style.display = 'none';
  document.getElementById('certForm').style.display = 'block';
}

// Eventos para data
document.getElementById('mes').addEventListener('change', atualizarDias);
document.getElementById('ano').addEventListener('input', atualizarDias);
// Pré-definir ano atual e mês atual
const hoje = new Date();
document.getElementById('ano').value = hoje.getFullYear();
document.getElementById('mes').value = hoje.getMonth() + 1;
atualizarDias();

// Campos dinâmicos conforme tipo selecionado
document.getElementById('tipo').addEventListener('change', function() {
  const tipo = parseInt(this.value);
  const lista = examesPorTipo[tipo] || [];
  let html = '<div class="grid-2">';
  lista.forEach(campo => {
    const label = formatarNomeCampo(campo);
    if (opcoesSelect[campo]) {
      html += '<div class="campo"><label>' + label + '</label><select name="' + campo + '" id="campo_' + campo + '"><option value="" selected disabled>Selec...</option>';
      opcoesSelect[campo].forEach(opt => { html += '<option value="' + opt + '">' + opt + '</option>'; });
      html += '</select></div>';
    } else {
      let tipoInput = 'text';
      if (campo.includes('data') || ['dum','dpp','dataInicio','dataDiagnostico','dataInternamento','dataPartida','dataRetorno','dataVacinaFebreAmarela','dataTesteCovid'].includes(campo)) tipoInput = 'date';
      if (['peso','altura','gestacoes','partos','abortos','nascidosVivos','dosesCovid','validade','idadeGestacional','consultasCPN','contagem_reticulocitos','hemoglobina','hematocrito','glicemia','colesterolTotal','triglicerideos','frequenciaCardiaca','frequenciaRespiratoria','temperatura','saturacaoOxigenio'].includes(campo)) tipoInput = 'number';
      html += '<div class="campo"><label>' + label + '</label><input type="' + tipoInput + '" name="' + campo + '" id="campo_' + campo + '" placeholder="' + label + '" step="any"></div>';
    }
  });
  html += '</div>';
  document.getElementById('camposEspecificosContainer').innerHTML = html;
});

// Pré-visualização
document.getElementById('certForm').addEventListener('submit', function(e) {
  e.preventDefault();
  let html = '<div><strong>Paciente:</strong> ' + document.getElementById('nomeCompleto').value + '</div><div style="border-top:1px solid #eee; margin-top:1rem;">';
  document.querySelectorAll('#camposEspecificosContainer input, #camposEspecificosContainer select').forEach(i => {
    if (i.value) html += '<div><span>' + formatarNomeCampo(i.name) + '</span> <b>' + i.value + '</b></div>';
  });
  html += '</div>';
  document.getElementById('previewContent').innerHTML = html;
  document.getElementById('modalPreview').style.display = 'flex';
});

window.fecharPreview = () => { document.getElementById('modalPreview').style.display = 'none'; };

// Confirmação e envio
document.getElementById('btnConfirmarFinal').addEventListener('click', async function() {
  fecharPreview();
  document.getElementById('btnEmitir').disabled = true;
  document.getElementById('btnEmitir').textContent = '⏳ Emitindo...';

  // Construir data de nascimento a partir dos campos
  const dia = document.getElementById('dia').value;
  const mes = document.getElementById('mes').value;
  const ano = document.getElementById('ano').value;
  if (!dia || !mes || !ano) {
    alert('Preencha a data de nascimento completa.');
    document.getElementById('btnEmitir').disabled = false;
    document.getElementById('btnEmitir').textContent = '📥 Emitir certificado';
    return;
  }
  const dataNascimento = ano + '-' + mes.padStart(2,'0') + '-' + dia.padStart(2,'0');

  const tipo = parseInt(document.getElementById('tipo').value);
  const payload = {
    tipo: tipo,
    paciente: {
      nomeCompleto: document.getElementById('nomeCompleto').value,
      bi: document.getElementById('bi').value,
      dataNascimento: dataNascimento,
      genero: document.getElementById('genero').value,
      telefone: document.getElementById('telefone').value
    },
    laborantin: {
      nome: document.getElementById('laborantinNome').value,
      registro: document.getElementById('laborantinRegistro').value
    },
    dados: {}
  };
  (examesPorTipo[tipo] || []).forEach(campo => {
    const el = document.getElementById('campo_' + campo);
    if (el && el.value.trim() !== '') {
      if (['peso','altura','gestacoes','partos','abortos','nascidosVivos','dosesCovid','idadeGestacional','consultasCPN','hemoglobina','hematocrito','glicemia','colesterolTotal','triglicerideos','frequenciaCardiaca','frequenciaRespiratoria','temperatura','saturacaoOxigenio'].includes(campo)) {
        payload.dados[campo] = parseFloat(el.value.replace(',','.'));
      } else {
        payload.dados[campo] = el.value.trim();
      }
    }
  });

  try {
    const r = await fetch('/api/laboratorio/certificados', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.erro || 'Erro');
    document.getElementById('certForm').style.display = 'none';
    document.getElementById('resultadoArea').innerHTML = '<div style="background:white; padding:2rem; text-align:center; border-radius:12px;"><div style="color:#006633; font-size:2rem;">✅ Sucesso</div><div style="background:#ffcc00; padding:0.5rem; border-radius:60px; margin:1rem 0;">' + data.numero + '</div><p><strong>IMC:</strong> ' + (data.imc || '—') + ' | ' + (data.classificacaoIMC || '—') + '</p><p><strong>Idade:</strong> ' + (data.idade || '?') + ' anos</p><button class="btn-emitir" onclick="location.reload()">➕ Novo</button></div>';
    document.getElementById('resultadoArea').style.display = 'block';
  } catch (error) {
    alert('Erro: ' + error.message);
  } finally {
    document.getElementById('btnEmitir').disabled = false;
    document.getElementById('btnEmitir').textContent = '📥 Emitir certificado';
  }
});
</script>
</body></html>
  `);
});

// ========== API Routes ==========
app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave API não fornecida' });
    const prefix = apiKey.split('-')[0];
    if (prefix !== 'LAB') return res.status(403).json({ erro: 'Chave inválida para laboratório' });

    const labs = await Establishment.find({ establishmentType: 'laboratorio', keyPrefix: 'LAB-' }).select('+keyHash');
    let lab = null;
    for (const est of labs) {
      if (await bcrypt.compare(apiKey, est.keyHash)) { lab = est; break; }
    }
    if (!lab) return res.status(401).json({ erro: 'Chave API inválida' });
    if (lab.status === 'Inativo') return res.status(403).json({ erro: 'Laboratório inativo' });

    const token = jwt.sign({ id: lab._id }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '7d' });
    res.json({ token, lab: { nome: lab.name } });
  } catch (error) {
    console.error('Erro login:', error);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

app.get('/api/laboratorio/stats', authJWT, async (req, res) => {
  try {
    const total = await Certificate.countDocuments({ establishmentId: req.lab._id });
    const porTipo = await Certificate.aggregate([
      { $match: { establishmentId: req.lab._id } },
      { $group: { _id: '$diseaseCategory', count: { $sum: 1 } } }
    ]);
    res.json({ total, porTipo });
  } catch (error) {
    console.error('Erro stats:', error);
    res.status(500).json({ erro: 'Erro stats' });
  }
});

app.get('/api/laboratorio/certificados', authJWT, async (req, res) => {
  try {
    const { tipo, paciente } = req.query;
    const query = { establishmentId: req.lab._id };
    if (tipo) query.diseaseCategory = `Tipo ${tipo}`;
    if (paciente) query.patientName = { $regex: paciente, $options: 'i' };
    const certs = await Certificate.find(query).sort({ createdAt: -1 }).limit(100);
    res.json(certs);
  } catch (error) {
    console.error('Erro listagem:', error);
    res.status(500).json({ erro: 'Erro ao listar certificados' });
  }
});

app.post('/api/laboratorio/certificados', authJWT, async (req, res) => {
  try {
    const { tipo, paciente, laborantin, dados } = req.body;
    if (!tipo || !paciente || !paciente.nomeCompleto || !laborantin || !laborantin.nome) {
      return res.status(400).json({ erro: 'Campos obrigatórios' });
    }

    // Geração do número com ID do laboratório (proposição 3)
    const numero = gerarNumeroCertificado(req.lab._id);
    const idade = paciente.dataNascimento ? calcularIdade(paciente.dataNascimento) : null;
    let imc = null, classificacaoIMC = null;
    if (dados && dados.peso && dados.altura) {
      const calc = calcularIMC(dados.peso, dados.altura);
      imc = calc.imc;
      classificacaoIMC = calc.classificacao;
    }

    const certificate = new Certificate({
      establishmentId: req.lab._id,
      createdBy: laborantin.nome,
      certificateNumber: numero,
      patientName: paciente.nomeCompleto,
      patientId: paciente.bi || null,
      patientBirthDate: paciente.dataNascimento ? new Date(paciente.dataNascimento) : null,
      diseaseCategory: `Tipo ${tipo}`,
      diagnosis: 'Diversos',
      testResults: dados,
      idadeCalculada: idade,
      imcCalculado: imc,
      classificacaoIMC: classificacaoIMC
    });
    await certificate.save();

    req.lab.totalEmissoes = (req.lab.totalEmissoes || 0) + 1;
    await req.lab.save();

    res.json({ success: true, numero, idade, imc, classificacaoIMC });
  } catch (error) {
    console.error('Erro criação:', error);
    // Caso extremamente raro de duplicação (quase impossível), retorna mensagem amigável
    if (error.code === 11000) {
      return res.status(409).json({ erro: 'Número de certificado duplicado. Por favor, tente novamente.' });
    }
    res.status(500).json({ erro: 'Erro interno: ' + error.message });
  }
});

app.get('/api/laboratorio/certificados/:id/pdf', authJWT, async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id);
    if (!certificate) return res.status(404).json({ erro: 'Certificado não encontrado' });
    if (certificate.establishmentId.toString() !== req.lab._id.toString()) return res.status(403).json({ erro: 'Acesso negado' });

    const lab = req.lab;
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${certificate.certificateNumber}.pdf`);
    doc.pipe(res);

    // En-tête
    doc.fillColor('#006633');
    doc.fontSize(20).text('REPÚBLICA DE ANGOLA', 0, 50, { align: 'center' });
    doc.fontSize(16).text('MINISTÉRIO DA SAÚDE', 0, 80, { align: 'center' });
    doc.fontSize(24).text('SISTEMA NACIONAL DE SAÚDE', 0, 110, { align: 'center' });
    doc.strokeColor('#006633').lineWidth(2)
      .moveTo(doc.page.width / 2 - 250, 150)
      .lineTo(doc.page.width / 2 + 250, 150)
      .stroke();
    let y = 180;

    doc.fontSize(14).text(lab.name, 50, y);
    doc.fontSize(10).fillColor('#666').text(`NIF: ${lab.nif} | ${lab.province}`, 50, y + 20);
    doc.text(`Endereço: ${lab.address} | Tel: ${lab.phone1}`, 50, y + 35);
    y += 60;

    doc.fillColor('#006633').fontSize(12).text(`CERTIFICADO Nº: ${certificate.certificateNumber}`, 50, y);
    doc.fontSize(10).fillColor('#666').text(`Emissão: ${new Date(certificate.createdAt).toLocaleDateString('pt-PT')}`, 50, y + 15);
    y += 40;

    doc.fillColor('#006633').text('RESPONSÁVEL PELA EMISSÃO:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificate.createdBy}`, 70, y);
    y += 15;

    doc.fillColor('#006633').text('PACIENTE:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificate.patientName}`, 70, y);
    y += 15;
    if (certificate.patientId) { doc.text(`Documento: ${certificate.patientId}`, 70, y); y += 15; }
    if (certificate.patientBirthDate) { doc.text(`Nascimento: ${new Date(certificate.patientBirthDate).toLocaleDateString('pt-PT')}`, 70, y); y += 15; }
    if (certificate.idadeCalculada) { doc.text(`Idade: ${certificate.idadeCalculada} anos`, 70, y); y += 15; }

    if (certificate.testResults && Object.keys(certificate.testResults).length > 0) {
      doc.fillColor('#006633').text('RESULTADOS:', 50, y);
      y += 20;
      doc.fillColor('#000').fontSize(10);
      for (let [chave, valor] of Object.entries(certificate.testResults)) {
        const chaveFormatada = chave.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
        doc.text(`${chaveFormatada}: ${valor}`, 70, y);
        y += 15;
        if (y > 700) { doc.addPage(); y = 50; }
      }
    }

    if (certificate.imcCalculado) {
      doc.fillColor('#006633').text('ÍNDICE DE MASSA CORPORAL:', 50, y);
      y += 20;
      doc.fillColor('#000').fontSize(11).text(`IMC: ${certificate.imcCalculado} (${certificate.classificacaoIMC})`, 70, y);
      y += 25;
    }

    try {
      const qrData = `${certificate.certificateNumber}|${lab.name}|${certificate.patientName}`;
      const qrBuffer = await QRCode.toBuffer(qrData, { width: 100 });
      doc.image(qrBuffer, 450, 650, { width: 100 });
    } catch (qrError) { console.error('Erro QR:', qrError); }

    doc.lineWidth(1).moveTo(70, y).lineTo(270, y).stroke();
    doc.fontSize(10).text('Assinatura do Laborantin', 70, y + 5).text(certificate.createdBy || '______', 70, y + 20);
    doc.lineWidth(1).moveTo(350, y).lineTo(550, y).stroke();
    doc.fontSize(10).text('Assinatura do Diretor', 350, y + 5).text(lab.director || '______', 350, y + 20);

    doc.fontSize(8).fillColor('#666').text('Documento válido em todo território nacional', 0, 780, { align: 'center' });
    doc.end();
  } catch (error) {
    console.error('Erro PDF:', error);
    res.status(500).json({ erro: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Laboratório rodando na porta ${PORT}`));