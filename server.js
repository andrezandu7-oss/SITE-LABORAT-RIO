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

// Connexion MongoDB (sans options obsolètes)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sns';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Erro MongoDB:', err));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======== Modèles ========
const PROVINCIAS = [
  'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango', 'Cuanza Norte',
  'Cuanza Sul', 'Cunene', 'Huambo', 'Huila', 'Luanda', 'Lunda Norte',
  'Lunda Sul', 'Malanje', 'Moxico', 'Namibe', 'Uíge', 'Zaire'
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

const Establishment = mongoose.model('Establishment', establishmentSchema);

const certificateSchema = new mongoose.Schema({
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true, index: true },
  createdBy: { type: String },
  certificateNumber: { type: String, required: true, unique: true },
  patientName: { type: String, required: true },
  patientGender: { type: String }, // 'M' ou 'F'
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
const camposPorTipo = {
  1: ['grupoSanguineo','fatorRh','genotipo','hemoglobina','hematocrito','contagem_reticulocitos','eletroforese'],
  2: ['peso','altura','pressaoArterial','frequenciaCardiaca','frequenciaRespiratoria','temperatura','saturacaoOxigenio','glicemia','colesterolTotal','triglicerideos'],
  3: ['tipoIncapacidade','causa','grau','dataInicio','partesAfetadas','limitacoes','necessitaAcompanhante'],
  4: ['tipoAptidao','modalidade','resultado','restricoes','validade'],
  5: ['gestacoes','partos','abortos','nascidosVivos','dum','dpp','idadeGestacional','consultasCPN','hemograma','gotaEspessa','hiv','vdrl','hbs','glicemia','creatinina','ureia','tgo','grupoSanguineo','fatorRh','exsudadoVaginal','pesoAtual','alturaUterina','batimentosCardiacosFeto','movimentosFetais','edema','proteinuria'],
  6: ['grupoSanguineo','fatorRh','hemograma','gotaEspessa','hiv','vdrl','hbs','vidal','glicemia','creatinina','ureia','tgo','testeGravidez','exsudadoVaginal','vs','falsiformacao'],
  7: ['doenca','outraDoenca','dataInicioSintomas','dataDiagnostico','metodoDiagnostico','tipoExame','resultado','tratamento','internamento','dataInternamento','contatos'],
  8: ['destino','motivoViagem','dataPartida','dataRetorno','vacinaFebreAmarela','dataVacinaFebreAmarela','loteVacinaFebreAmarela','vacinaCovid19','dosesCovid','testeCovid','tipoTesteCovid','dataTesteCovid','resultadoTesteCovid','outrasVacinas','medicamentos','condicoesEspeciais','recomendacoes']
};

function formatarNomeCampo(chave) {
  return chave.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
}

function gerarNumeroCertificado(labId) {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = (agora.getMonth() + 1).toString().padStart(2, '0');
  const dia = agora.getDate().toString().padStart(2, '0');
  const hora = agora.getHours().toString().padStart(2, '0');
  const min = agora.getMinutes().toString().padStart(2, '0');
  const seg = agora.getSeconds().toString().padStart(2, '0');
  const ms = agora.getMilliseconds().toString().padStart(3, '0');
  const labPart = labId.toString().slice(-4).toUpperCase();
  const random = crypto.randomBytes(6).toString('hex').toUpperCase();
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
  if (!peso || !altura || altura === 0) return { imc: null, classificacao: null };
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

// ========== Middleware JWT (corrigé) ==========
const authJWT = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
    const lab = await Establishment.findById(decoded.id);
    if (!lab) return res.status(401).json({ erro: 'Laboratório não encontrado' });
    // Vérification avec isActive et licence
    if (!lab.isActive || lab.licenseValidity < new Date()) {
      return res.status(403).json({ erro: 'Laboratório inativo' });
    }
    req.lab = lab;
    next();
  } catch (err) {
    return res.status(403).json({ erro: 'Token inválido' });
  }
};

// ========== Rotas HTML (inchangées, mais vérifiées) ==========
// (Les routes /, /dashboard, /novo-certificado sont identiques au dernier code fourni,
//  je les omet ici pour éviter de surcharger, mais elles doivent être présentes.
//  Assurez-vous qu'il n'y a pas de guillemets mal échappés, notamment dans la fonction baixarPDF.)

// ========== API Routes (avec les corrections) ==========
app.post('/api/laboratorio/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ erro: 'Chave API não fornecida' });
    const prefix = apiKey.split('-')[0];
    if (prefix !== 'LAB') return res.status(403).json({ erro: 'Chave inválida para laboratório' });

    const labs = await Establishment.find({ establishmentType: 'laboratorio' }).select('+keyHash');
    let lab = null;
    for (const est of labs) {
      if (await bcrypt.compare(apiKey, est.keyHash)) {
        lab = est;
        break;
      }
    }
    if (!lab) return res.status(401).json({ erro: 'Chave API inválida' });
    // Vérification avec isActive et licence (pas de virtual)
    if (!lab.isActive || lab.licenseValidity < new Date()) {
      return res.status(403).json({ erro: 'Laboratório inativo' });
    }

    const token = jwt.sign({ id: lab._id }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '7d' });
    res.json({ token, lab: { nome: lab.name } });
  } catch (error) {
    console.error('Erro login:', error);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// Les autres routes (stats, certificados, pdf) restent identiques à la version précédente.

app.listen(PORT, () => console.log(`🚀 Laboratório rodando na porta ${PORT}`));