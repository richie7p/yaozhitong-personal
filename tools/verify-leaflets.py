"""Read-only source/extraction QA. Does not mark any document published."""
import json, pathlib, re, unicodedata, collections, subprocess, shutil
from pypdf import PdfReader
from PIL import Image,ImageDraw
root=pathlib.Path('.local'); db=json.loads((root/'db.json').read_text(encoding='utf-8-sig')); out=root/'reports'/'pdf-review';out.mkdir(parents=True,exist_ok=True)
def normalize(s):return re.sub(r'\s+','',unicodedata.normalize('NFKC',s))
report=[]; previews=[]
for i,l in enumerate(db.get('leaflets',{}).values()):
    pdf=root/'blobs'/l['storagePath'];reader=PdfReader(pdf);pages=[]
    for n,p in enumerate(reader.pages,1):
        source=normalize(p.extract_text() or ''); extracted=normalize(''.join(c['text'] for c in l['chunks'] if c['page']==n));a=collections.Counter(source);b=collections.Counter(extracted); overlap=sum((a&b).values());ratio=overlap/max(len(source),len(extracted),1)
        pages.append({'page':n,'sourceChars':len(source),'extractedChars':len(extracted),'characterCoverage':round(ratio,4)})
    report.append({'id':l['id'],'licenseNo':l['licenseNo'],'pages':pages,'sourceHash':l['sha256'],'status':'needs_visual_review','note':'Character coverage compares two extraction engines; it does not establish semantic or clinical correctness.'})
    target=out/f'{i+1:02d}'
    subprocess.run([shutil.which('pdftoppm'),'-f','1','-singlefile','-scale-to','950','-png',str(pdf),str(target)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    previews.append((str(target)+'.png',l['licenseNo']))
for group in range(0,len(previews),6):
    sheet=Image.new('RGB',(1500,1500),'#ddd');draw=ImageDraw.Draw(sheet)
    for k,(file,lic) in enumerate(previews[group:group+6]):
        im=Image.open(file);im.thumbnail((485,690));x=(k%3)*500;y=(k//3)*750;sheet.paste(im,(x+(500-im.width)//2,y+35));draw.text((x+15,y+10),f'PDF {group+k+1:02d}',fill='black')
    sheet.save(out/f'contact-{group//6+1}.png')
(out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({'documents':len(report),'pages':sum(len(r['pages']) for r in report),'below95Percent':sum(p['characterCoverage']<.95 for r in report for p in r['pages'])}))
