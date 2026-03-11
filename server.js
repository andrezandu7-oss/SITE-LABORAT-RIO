// server.js (adicione/modifique as rotas de certificado)

// ... (todo o código existente permanece, apenas atualizamos as rotas de certificado)

// Função auxiliar para calcular idade a partir da data de nascimento
function calcularIdade(dataNascimento) {
  if (!dataNascimento) return null;
  const hoje = new Date();
  const nasc = new Date(dataNascimento);
  let idade = hoje.getFullYear() - nasc.getFullYear();
  const m = hoje.getMonth() - nasc.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < nasc.getDate())) idade--;
  return idade;
}

// Função auxiliar para calcular IMC e classificação
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

// Rota para criar certificado (adaptada para os novos campos)
app.post('/api/laboratorio/certificados', authLaboratorio, async (req, res) => {
  try {
    const { tipo, paciente, laborantin, dados } = req.body;
    if (!tipo || !paciente || !paciente.nomeCompleto || !laborantin || !laborantin.nome) {
      return res.status(400).json({ erro: 'Campos obrigatórios: tipo, paciente.nomeCompleto, laborantin.nome' });
    }

    // Gera número único
    const numero = gerarNumeroCertificado();
    const hash = crypto.createHash('sha256').update(numero + Date.now()).digest('hex');

    // Calcula idade (se data de nascimento fornecida)
    let idade = null;
    if (paciente.dataNascimento) {
      idade = calcularIdade(paciente.dataNascimento);
    }

    // Calcula IMC se peso e altura estiverem presentes em dados
    let imc = null, classificacaoIMC = null;
    if (dados && dados.peso && dados.altura) {
      const calc = calcularIMC(dados.peso, dados.altura);
      imc = calc.imc;
      classificacaoIMC = calc.classificacao;
    }

    // Cria o certificado
    const certificate = new Certificate({
      establishmentId: req.lab._id,
      createdBy: laborantin.nome,
      certificateNumber: numero,
      patientName: paciente.nomeCompleto,
      patientId: paciente.bi || null,
      patientBirthDate: paciente.dataNascimento ? new Date(paciente.dataNascimento) : null,
      diseaseCategory: `Tipo ${tipo}`, // ou usar um mapeamento de tipos
      diagnosis: 'Ver dados', // simplificado, os dados detalhados estarão em testResults
      testResults: dados, // guarda todos os campos específicos
      // opcionais:
      idadeCalculada: idade,
      imcCalculado: imc,
      classificacaoIMC: classificacaoIMC
    });
    await certificate.save();

    // Incrementa contador do laboratório
    req.lab.totalEmissoes++;
    await req.lab.save();

    res.json({
      success: true,
      numero,
      idade,
      imc,
      classificacaoIMC
    });
  } catch (error) {
    console.error('Erro ao criar certificado:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Rota para gerar PDF (enriquecida)
app.get('/api/laboratorio/certificados/:id/pdf', authLaboratorio, async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id);
    if (!certificate) return res.status(404).json({ erro: 'Certificado não encontrado' });
    if (certificate.establishmentId.toString() !== req.lab._id.toString()) {
      return res.status(403).json({ erro: 'Acesso negado' });
    }

    const lab = req.lab;
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${certificate.certificateNumber}.pdf`);
    doc.pipe(res);

    // --- Cabeçalho ---
    doc.fillColor('#006633');
    doc.fontSize(20).text('REPÚBLICA DE ANGOLA', 0, 50, { align: 'center' });
    doc.fontSize(16).text('MINISTÉRIO DA SAÚDE', 0, 80, { align: 'center' });
    doc.fontSize(24).text('SISTEMA NACIONAL DE SAÚDE', 0, 110, { align: 'center' });
    doc.strokeColor('#006633').lineWidth(2)
      .moveTo(doc.page.width / 2 - 250, 150)
      .lineTo(doc.page.width / 2 + 250, 150)
      .stroke();
    let y = 180;

    // --- Laboratório emissor ---
    doc.fontSize(14).text(lab.name, 50, y);
    doc.fontSize(10).fillColor('#666').text(`NIF: ${lab.nif} | ${lab.province}`, 50, y + 20);
    doc.text(`Endereço: ${lab.address} | Tel: ${lab.phone1}`, 50, y + 35);
    y += 60;

    // --- Nº do certificado ---
    doc.fillColor('#006633').fontSize(12).text(`CERTIFICADO Nº: ${certificate.certificateNumber}`, 50, y);
    doc.fontSize(10).fillColor('#666').text(`Emissão: ${new Date(certificate.createdAt).toLocaleDateString('pt-PT')}`, 50, y + 15);
    y += 40;

    // --- Responsável pela emissão ---
    doc.fillColor('#006633').text('RESPONSÁVEL PELA EMISSÃO:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificate.createdBy}`, 70, y);
    y += 15;

    // --- Paciente ---
    doc.fillColor('#006633').text('PACIENTE:', 50, y);
    y += 20;
    doc.fillColor('#000').fontSize(11).text(`Nome: ${certificate.patientName}`, 70, y);
    y += 15;
    if (certificate.patientId) {
      doc.text(`Documento: ${certificate.patientId}`, 70, y);
      y += 15;
    }
    if (certificate.patientBirthDate) {
      doc.text(`Nascimento: ${new Date(certificate.patientBirthDate).toLocaleDateString('pt-PT')}`, 70, y);
      y += 15;
    }
    if (certificate.idadeCalculada) {
      doc.text(`Idade: ${certificate.idadeCalculada} anos`, 70, y);
      y += 15;
    }

    // --- Dados médicos (testResults) ---
    if (certificate.testResults && Object.keys(certificate.testResults).length > 0) {
      doc.fillColor('#006633').text('RESULTADOS / OBSERVAÇÕES:', 50, y);
      y += 20;
      doc.fillColor('#000').fontSize(10);
      for (let [chave, valor] of Object.entries(certificate.testResults)) {
        // Formata o nome da chave
        const chaveFormatada = chave.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
        doc.text(`${chaveFormatada}: ${valor}`, 70, y);
        y += 15;
        if (y > 700) { doc.addPage(); y = 50; }
      }
    }

    // --- IMC se calculado ---
    if (certificate.imcCalculado) {
      doc.fillColor('#006633').text('ÍNDICE DE MASSA CORPORAL:', 50, y);
      y += 20;
      doc.fillColor('#000').fontSize(11).text(`IMC: ${certificate.imcCalculado} (${certificate.classificacaoIMC})`, 70, y);
      y += 25;
    }

    // --- QR Code (opcional) ---
    try {
      const qrData = `${certificate.certificateNumber}|${lab.name}|${certificate.patientName}`;
      const qrBuffer = await QRCode.toBuffer(qrData, { width: 100 });
      doc.image(qrBuffer, 450, 650, { width: 100 });
    } catch (qrError) {
      console.error('Erro QR:', qrError);
    }

    // --- Assinaturas ---
    doc.lineWidth(1).moveTo(70, y).lineTo(270, y).stroke();
    doc.fontSize(10).text('Assinatura do Laborantin', 70, y + 5).text(certificate.createdBy || '______', 70, y + 20);
    doc.lineWidth(1).moveTo(350, y).lineTo(550, y).stroke();
    doc.fontSize(10).text('Assinatura do Diretor', 350, y + 5).text(lab.director || '______', 350, y + 20);

    // --- Rodapé ---
    doc.fontSize(8).fillColor('#666').text('Documento válido em todo território nacional', 0, 780, { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('Erro PDF:', error);
    res.status(500).json({ erro: error.message });
  }
});