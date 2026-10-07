import ast
import sys

source = open(sys.argv[1], encoding='utf-8').read()
ast.parse(source)
print('ok')
